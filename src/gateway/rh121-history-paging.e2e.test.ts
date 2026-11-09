// Candidate only. Install at src/gateway/rh121-history-paging.e2e.test.ts for the normal E2E wrapper.
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { captureRuntimeConfigAsyncReader } from "../config/config.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readChatHistoryMessageId } from "./session-history-tail.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

type Page = {
  messages: unknown[];
  olderCursor?: string;
  newerCursor?: string;
  windowReset?: boolean;
};

it(
  "RH121 serves byte-limited earlier pages and advances anchor-only history over public WebSocket",
  { timeout: 90_000 },
  async () => {
    await withOpenClawTestState(
      {
        label: "rh121-public-history",
        layout: "home",
        env: {
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_GATEWAY_PASSWORD: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      },
      async (state) => {
        state.envVars.OPENCLAW_BUNDLED_PLUGINS_DIR = state.path("no-plugins");
        state.applyEnv();
        const token = "synthetic-rh121-history-token";
        const cfg = {
          agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
          gateway: {
            auth: { mode: "token", token },
            controlUi: { allowedOrigins: ["http://localhost"] },
          },
          models: { mode: "replace", providers: {} },
          plugins: { slots: { memory: "none" } },
          tools: { profile: "minimal" },
        } satisfies OpenClawConfig;
        await state.writeConfig(cfg);
        await captureRuntimeConfigAsyncReader()();
        const fixtures = [
          { name: "mixed", widths: [1, 3, 1, 3, 1, 3], closed: false },
          { name: "adjacent", widths: [5, 5], closed: false },
          { name: "closed", widths: [5, 5], closed: true },
        ];
        const seeded: Array<
          (typeof fixtures)[number] & {
            scope: { agentId: string; sessionKey: string; sessionId: string };
            ids: string[];
            fingerprint: () => Promise<string>;
            before: string;
          }
        > = [];
        for (const fixture of fixtures) {
          const sessionId = "rh121-" + fixture.name;
          const scope = { agentId: "main", sessionKey: "agent:main:" + sessionId, sessionId };
          const ids = fixture.widths.map((_, index) => fixture.name + "-" + index);
          await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
          await replaceTranscriptEvents(scope, [
            { type: "session", version: 3, id: sessionId },
            ...fixture.widths.map((width, index) => ({
              type: "message",
              id: ids[index],
              parentId: index ? ids[index - 1] : null,
              message: {
                role: "user",
                content: "x".repeat(width * 1024 * 1024),
                timestamp: index + 1,
              },
            })),
            ...(fixture.closed
              ? [
                  {
                    type: "reset",
                    id: "closing",
                    parentId: ids.at(-1),
                    reason: "new",
                    timestamp: "2026-10-11T00:00:01.000Z",
                  },
                  {
                    type: "message",
                    id: "current",
                    parentId: "closing",
                    message: {
                      role: "user",
                      content: "Current interval must not leak into older pages",
                    },
                  },
                ]
              : []),
          ]);
          const fingerprint = async () =>
            createHash("sha256")
              .update(JSON.stringify(await loadTranscriptEvents(scope)))
              .digest("hex");
          seeded.push({ ...fixture, scope, ids, fingerprint, before: await fingerprint() });
        }
        let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
        await runQaGatewayFixture(
          async () => {
            gateway = await startGatewayWithClient({
              cfg,
              configPath: state.configPath,
              token,
              clientName: "openclaw-control-ui",
              mode: "webchat",
              origin: "http://localhost",
              scopes: ["operator.admin", "operator.read", "operator.write"],
            });
            for (const fixture of seeded) {
              const read = async (params: Record<string, unknown>) => {
                const page = await gateway!.client.request<Page>("chat.history", {
                  sessionKey: fixture.scope.sessionKey,
                  maxBytes: 512 * 1024,
                  maxChars: 200,
                  ...params,
                });
                expect(Array.isArray(page.messages)).toBe(true);
                expect(page.windowReset).not.toBe(true);
                expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThanOrEqual(
                  512 * 1024,
                );
                return page;
              };
              let page = await read({ messageId: fixture.ids.at(-1), limit: 1 });
              expect(page.messages.map(readChatHistoryMessageId)).toEqual([fixture.ids.at(-1)]);
              expect(page.olderCursor).toEqual(expect.any(String));
              const observed = page.messages.map(readChatHistoryMessageId);
              const cursors = new Set<string>();
              let pagesLeft = fixture.ids.length;
              while (page.olderCursor && pagesLeft-- > 0) {
                expect(cursors.has(page.olderCursor)).toBe(false);
                cursors.add(page.olderCursor);
                page = await read({
                  cursor: page.olderCursor,
                  limit: fixture.name === "mixed" ? 6 : 1,
                });
                const ids = page.messages.map(readChatHistoryMessageId);
                expect(ids.length).toBeGreaterThan(0);
                const start = fixture.ids.indexOf(ids[0]!);
                expect(start).toBeGreaterThanOrEqual(0);
                expect(ids).toEqual(fixture.ids.slice(start, start + ids.length));
                expect(ids.some((id) => observed.includes(id))).toBe(false);
                observed.unshift(...ids);
              }
              expect(page.olderCursor).toBeUndefined();
              expect(observed).toEqual(fixture.ids);
              if (fixture.name !== "mixed") {
                expect(page.newerCursor).toEqual(expect.any(String));
                const newer = await read({ cursor: page.newerCursor, limit: 1 });
                expect(newer.messages.map(readChatHistoryMessageId)).toEqual([fixture.ids[1]]);
                if (fixture.closed) {
                  expect(newer.newerCursor).toEqual(expect.any(String));
                  const end = await read({ cursor: newer.newerCursor, limit: 1 });
                  expect(end.messages.map(readChatHistoryMessageId)).toEqual(["closing"]);
                  expect(end.newerCursor).toBeUndefined();
                } else {
                  expect(newer.newerCursor).toBeUndefined();
                }
              }
              expect(await fixture.fingerprint()).toBe(fixture.before);
            }
          },
          () => (gateway ? disconnectGatewayClient(gateway.client) : undefined),
          () => gateway?.server.close({ reason: "RH121 history proof complete" }),
        );
      },
    );
  },
);
