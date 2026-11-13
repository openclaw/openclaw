import { appendFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { applySessionEntryCanonicalReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGatewayAuth } from "./auth.js";
import { handleControlUiAssistantMediaRequest } from "./control-ui.js";
import { finishFailedGatewayHttpResponse } from "./http-common.js";

type StandaloneVariant = {
  name: string;
  roles: boolean;
  mode?: "creator" | "audience" | "source" | "unrestricted";
  shared?: boolean;
  allowed: boolean;
};
const standaloneCases: StandaloneVariant[] = [
  { name: "legacy roleless Draft", roles: false, allowed: true },
  { name: "legacy named-role Draft", roles: true, allowed: false },
  { name: "explicit creator Draft", roles: false, mode: "creator", allowed: false },
  { name: "explicit selected-audience Draft", roles: false, mode: "audience", allowed: false },
  { name: "explicit source Draft", roles: false, mode: "source", allowed: false },
  { name: "explicit unrestricted Draft", roles: false, mode: "unrestricted", allowed: false },
  {
    name: "explicit selected-audience Shared",
    roles: false,
    mode: "audience",
    shared: true,
    allowed: true,
  },
];
const attachmentBytes = Buffer.from("synthetic standalone attachment bytes\n");
const attachmentEmails = {
  creator: "attachment-creator@example.test",
  reader: "attachment-reader@example.test",
  excluded: "attachment-excluded@example.test",
};
async function withStandaloneAttachment(
  variant: StandaloneVariant,
  run: (f: {
    request: (actor: keyof typeof attachmentEmails) => Promise<{ status: number; bytes: Buffer }>;
    scope: { agentId: string; sessionKey: string; sessionId: string };
    storePath: string;
    file: string;
  }) => Promise<void>,
) {
  const trace: Record<string, unknown>[] = [];
  try {
    await withOpenClawTestState(
      { scenario: "minimal", prepareProfileCatalog: true },
      async (state) => {
        const cfg: OpenClawConfig = {
          agents: { entries: { main: { workspace: state.workspaceDir } } },
          plugins: { enabled: false },
          gateway: {
            trustedProxies: ["127.0.0.1"],
            auth: {
              mode: "trusted-proxy",
              trustedProxy: { userHeader: "x-forwarded-user", allowLoopback: true },
            },
            ...(variant.roles
              ? {
                  roles: {
                    default: "reader",
                    definitions: {
                      reader: {
                        agents: "*",
                        scopes: ["operator.read"],
                        sessions: { others: "view" },
                      },
                    },
                  },
                }
              : {}),
          },
        };
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        const profiles = new Map<keyof typeof attachmentEmails, string>();
        for (const actor of Object.keys(attachmentEmails) as (keyof typeof attachmentEmails)[]) {
          profiles.set(
            actor,
            (await ensureCanonicalUserProfileForEmail(attachmentEmails[actor])).id,
          );
        }
        using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
        const scope = {
          agentId: "main",
          sessionKey: "agent:main:dashboard:legacy-attachment",
          sessionId: "legacy-attachment",
        };
        await upsertSessionEntryCore(scope, {
          sessionId: scope.sessionId,
          updatedAt: 1,
          visibility: variant.shared ? "shared" : "draft",
          permissionMode: "full",
          sessionRoot: state.workspaceDir,
          createdActor: { type: "human", source: "profile", id: profiles.get("creator")! },
          ...(variant.mode
            ? {
                access:
                  variant.mode === "audience"
                    ? { mode: variant.mode, profileIds: [profiles.get("reader")!] }
                    : { mode: variant.mode },
              }
            : {}),
        });
        const storePath = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
        const file = path.join(state.workspaceDir, "attachment.txt");
        await fs.writeFile(file, attachmentBytes);
        await withServer(
          (req, res) => {
            void handleControlUiAssistantMediaRequest(req, res, {
              config: cfg,
              agentId: "main",
              auth: resolveGatewayAuth({ authConfig: cfg.gateway?.auth }),
              trustedProxies: cfg.gateway?.trustedProxies,
            })
              .then((handled) => {
                if (!handled) {
                  res.statusCode = 418;
                  res.end();
                }
              })
              .catch(() => finishFailedGatewayHttpResponse(res));
          },
          async (url) => {
            await run({
              scope,
              storePath,
              file,
              request: async (actor) => {
                const query = new URLSearchParams({
                  source: file,
                  agentId: "main",
                  sessionKey: scope.sessionKey,
                });
                const response = await fetch(
                  url + "/__openclaw__/assistant-media?" + query.toString(),
                  {
                    headers: {
                      "x-forwarded-for": "192.0.2.10",
                      "x-forwarded-proto": "https",
                      "x-forwarded-user": attachmentEmails[actor],
                      "x-openclaw-scopes": "operator.read",
                    },
                  },
                );
                const bytes = Buffer.from(await response.arrayBuffer());
                trace.push({
                  UTC: new Date().toISOString(),
                  variant: variant.name,
                  actor,
                  roles: variant.roles,
                  access: variant.mode ?? null,
                  status: response.status,
                  responseBytes: bytes.length,
                  attachmentBytesServed: bytes.equals(attachmentBytes),
                });
                return { status: response.status, bytes };
              },
            });
          },
        );
      },
    );
  } finally {
    const output = process.env.OPENCLAW_TEST_ATTACHMENT_LEGACY_TRACE_PATH;
    if (output) {
      appendFileSync(output, trace.map((row) => JSON.stringify(row) + "\n").join(""));
    }
  }
}
it.each(standaloneCases)(
  "serves standalone attachment under $name without changing confidential eligibility",
  async (variant) => {
    await withStandaloneAttachment(variant, async ({ request }) => {
      const read = await request("reader");
      expect(read.status).toBe(variant.allowed ? 200 : 404);
      expect(read.bytes.equals(attachmentBytes)).toBe(variant.allowed);
      const creator = await request("creator");
      expect(creator.status).toBe(200);
      expect(creator.bytes).toEqual(attachmentBytes);
      if (variant.mode && variant.mode !== "unrestricted") {
        const excluded = await request("excluded");
        expect(excluded.status).toBe(404);
        expect(excluded.bytes.equals(attachmentBytes)).toBe(false);
      }
    });
  },
);
it("refuses final standalone bytes if a legacy row becomes confidential during file open", async () => {
  await withStandaloneAttachment(
    standaloneCases[0]!,
    async ({ request, scope, storePath, file }) => {
      const entered = createDeferred();
      const release = createDeferred();
      const open = fs.open;
      using _ = vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
        const handle = await open(target, flags, mode);
        if (target === file) {
          entered.resolve();
          await release.promise;
        }
        return handle;
      });
      const pending = request("reader");
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "standalone attachment file open",
        );
        await applySessionEntryCanonicalReplacements({
          agentId: scope.agentId,
          storePath,
          sessionKeys: [scope.sessionKey],
          update: (rows) => ({
            result: undefined,
            replacements: rows.map((row) => ({
              ...row,
              previousSessionKeys: [],
              accessMutation: true,
              entry: { ...row.entry, access: { mode: "creator" as const } },
            })),
          }),
        });
      } finally {
        release.resolve();
      }
      const denied = await pending;
      expect(denied.status).toBe(404);
      expect(denied.bytes.equals(attachmentBytes)).toBe(false);
      const owner = await request("creator");
      expect(owner.status).toBe(200);
      expect(owner.bytes).toEqual(attachmentBytes);
    },
  );
});
