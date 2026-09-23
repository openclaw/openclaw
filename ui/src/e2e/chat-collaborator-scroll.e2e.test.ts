import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  requireRecord,
  requireString,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Collaborator transcript scroll" });

suite.define(() => {
  it.each(["following", "reading"] as const)(
    "keeps the viewport stable when a collaborator sends a follow-up while %s",
    async (mode) => {
      await suite.withPage(
        { viewport: { width: 1200, height: 900 }, colorScheme: "dark" },
        async ({ page }) => {
          const sessionKey = "agent:main:dashboard:collaborator-scroll";
          const runId = "active-review";
          const now = Date.now() - 60_000;
          const history = [
            {
              role: "user",
              content: "Inspect the workspace and explain your findings.",
              timestamp: now,
              __openclaw: { id: "original-user", idempotencyKey: runId + ":user", seq: 1 },
            },
            ...Array.from({ length: 12 }, (_, index) => ({
              role: "assistant",
              phase: "commentary",
              content: [
                {
                  type: "text",
                  text:
                    "Finding " +
                    (index + 1) +
                    ": " +
                    "The workspace is organized into independent components. ".repeat(5),
                },
              ],
              timestamp: now + index + 1,
              __openclaw: { id: "finding-" + index, runId, seq: index + 2 },
            })),
            {
              role: "toolResult",
              toolCallId: "workspace-check",
              toolName: "exec",
              content: [{ type: "text", text: "Workspace check completed" }],
              timestamp: now + 15_000,
              __openclaw: { id: "workspace-check", runId, seq: 15 },
            },
          ];
          const session = {
            key: sessionKey,
            kind: "direct",
            status: "running",
            activeRunIds: [runId],
            hasActiveRun: true,
            updatedAt: now,
          };
          const gateway = await installMockGateway(page, {
            sessionKey,
            historyMessages: history,
            inFlightRun: { runId, text: "" },
            sessionInfo: session,
            sessions: [session],
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await page.locator(".chat-reading-indicator").waitFor();
          await waitForChatScrollIdle(page);
          const thread = page.locator(".chat-thread");
          if (mode === "reading") {
            await thread.hover();
            await page.mouse.wheel(0, -300);
            await waitForChatScrollIdle(page);
          }
          const artifacts = createControlUiE2eArtifactDir("collaborator-scroll-" + mode);
          await page.screenshot({ path: path.join(artifacts, "before-message.png") });
          const before = await thread.evaluate((element) => ({
            top: element.scrollTop,
            height: element.scrollHeight,
            frameKey: element.querySelector<HTMLElement>(
              '.chat-virtual-row[data-virtual-row-key^="agent-run:"]',
            )?.dataset.virtualRowKey,
          }));
          // Observe every animation frame, not only the eventual settled position.
          await thread.evaluate((element) => {
            const samples: number[] = [];
            let frame = 0;
            const sample = () => {
              samples.push(element.scrollTop);
              frame = requestAnimationFrame(sample);
            };
            Object.assign(element, {
              scrollSamples: samples,
              stopScrollSamples: () => cancelAnimationFrame(frame),
            });
            frame = requestAnimationFrame(sample);
          });
          const message = {
            role: "user",
            content: "Please also check the shared components.",
            timestamp: now + 20_000,
            __openclaw: {
              id: "collaborator-user",
              idempotencyKey: "collaborator-steer:user",
              seq: 20,
            },
          };
          await gateway.setHistoryMessages([...history, message]);
          const samplesBeforeEvent = await thread.evaluate(
            (element) =>
              (element as HTMLElement & { scrollSamples: number[] }).scrollSamples.length,
          );
          await gateway.emitGatewayEvent("session.message", {
            sessionKey,
            message,
            messageId: "collaborator-user",
            messageSeq: 20,
            hasActiveRun: true,
            activeRunIds: [runId],
            clientRunId: "collaborator-steer",
            session,
          });
          await page
            .getByText("Please also check the shared components.", { exact: true })
            .waitFor();
          await waitForChatScrollIdle(page);
          await page.screenshot({ path: path.join(artifacts, "after-message.png") });
          const after = await thread.evaluate((element) => {
            const sampling = element as HTMLElement & {
              scrollSamples: number[];
              stopScrollSamples: () => void;
            };
            sampling.stopScrollSamples();
            return {
              top: element.scrollTop,
              height: element.scrollHeight,
              samples: sampling.scrollSamples,
              keys: [...element.querySelectorAll<HTMLElement>(".chat-virtual-row")].map(
                (row) => row.dataset.virtualRowKey,
              ),
            };
          });
          console.log("COLLABORATOR_SCROLL", JSON.stringify({ mode, before, after }));
          expect(new Set(after.keys).size).toBe(after.keys.length);
          expect(after.keys[1]).toBe(before.frameKey);
          expect(after.samples.length).toBeGreaterThan(samplesBeforeEvent);
          // A peer append cannot acquire follow intent, including at the old end.
          for (let index = 1; index < after.samples.length; index += 1) {
            expect(after.samples[index]).toBeGreaterThanOrEqual(after.samples[index - 1]! - 1);
          }
          expect(Math.min(...after.samples)).toBeGreaterThanOrEqual(before.top - 1);
          expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1);
        },
      );
    },
  );

  it.each(["older-history", "near-bottom", "following"] as const)(
    "holds the reader anchor across another identified client's send while %s",
    async (mode) => {
      const options = { viewport: { width: 1200, height: 900 }, colorScheme: "dark" as const };
      await suite.withPage(options, async ({ page: reader }) => {
        await suite.withPage(options, async ({ page: sender }) => {
          const sessionKey = "agent:main:dashboard:two-client-" + mode;
          const sessionId = "two-client-session-" + mode;
          const runId = "long-active-run";
          const now = Date.now() - 120_000;
          const people = [
            {
              id: "reader-profile",
              name: "Reader One",
              identity: { type: "profile" as const, id: "reader-profile" },
            },
            {
              id: "sender-profile",
              name: "Writer Two",
              identity: { type: "profile" as const, id: "sender-profile" },
            },
          ];
          const attribution = (person: (typeof people)[number]) => ({
            senderId: person.id,
            senderName: person.name,
            senderIdentity: person.identity,
          });
          const history: unknown[] = Array.from({ length: 12 }, (_, index) => [
            {
              role: "user",
              content: "Earlier request " + index,
              timestamp: now + index * 2,
              __openclaw: {
                id: "earlier-user-" + index,
                seq: index * 2 + 1,
                idempotencyKey: "earlier-run-" + index + ":user",
                ...attribution(people[0]!),
              },
            },
            {
              role: "assistant",
              content:
                "Earlier answer " +
                index +
                ". " +
                "Retain this reading position while the shared conversation continues. ".repeat(5),
              timestamp: now + index * 2 + 1,
              __openclaw: {
                id: "earlier-answer-" + index,
                seq: index * 2 + 2,
                runId: "earlier-run-" + index,
              },
            },
          ]).flat();
          history.push({
            role: "user",
            content: "Inspect this long-running workspace task.",
            timestamp: now + 30,
            __openclaw: {
              id: "active-user",
              seq: 25,
              idempotencyKey: runId + ":user",
              ...attribution(people[0]!),
            },
          });
          for (let index = 0; index < 18; index += 1) {
            history.push({
              role: "assistant",
              phase: "commentary",
              content:
                "Active finding " +
                index +
                ". " +
                "The component remains independently testable and its current behavior is being inspected. ".repeat(
                  4,
                ),
              timestamp: now + 31 + index,
              __openclaw: { id: "active-finding-" + index, seq: 26 + index, runId },
            });
          }
          history.push({
            role: "toolResult",
            toolCallId: "workspace-tool",
            toolName: "exec",
            content: [{ type: "text", text: "Workspace check is running" }],
            timestamp: now + 60,
            __openclaw: { id: "workspace-tool", seq: 44, runId },
          });
          const session = {
            key: sessionKey,
            sessionId,
            kind: "direct",
            label: "Shared scroll proof",
            status: "running",
            hasActiveRun: true,
            activeRunIds: [runId],
            updatedAt: now,
          };
          const inFlightRun = { runId, text: "", startedAt: now + 30 };
          const snapshot = {
            messages: history,
            sessionId,
            sessionInfo: session,
            inFlightRun,
            pendingInputs: { items: [], total: 0 },
          };
          const config = {
            messages: { queue: { mode: "followup", byChannel: { webchat: "followup" } } },
          };
          const createClient = (page: typeof reader, self: string) =>
            installMockGateway(page, {
              sessionKey,
              sessionInfo: session,
              sessions: [session],
              hasMultipleSessionSharingIdentities: true,
              presenceUsers: people.map((person) => ({ ...person, self: person.id === self })),
              methodResponses: {
                "chat.startup": snapshot,
                "chat.history": snapshot,
                "config.get": {
                  config,
                  runtimeConfig: config,
                  raw: JSON.stringify(config),
                  hash: "shared-proof-config",
                  valid: true,
                  issues: [],
                },
              },
            });
          const readerGateway = await createClient(reader, people[0]!.id);
          const senderGateway = await createClient(sender, people[1]!.id);
          await Promise.all(
            [reader, sender].map((page) =>
              page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey)),
            ),
          );
          await Promise.all(
            [reader, sender].map((page) => page.locator(".chat-reading-indicator").waitFor()),
          );
          const connections = await Promise.all(
            [readerGateway, senderGateway].map((gateway) => gateway.waitForRequest("connect")),
          );
          const instances = connections.map(
            (connection) => requireRecord(requireRecord(connection.params).client).instanceId,
          );
          expect(instances[0]).not.toBe(instances[1]);
          await waitForChatScrollIdle(reader);
          const thread = reader.locator(".chat-thread");
          if (mode !== "following") {
            const activeHeight = await reader
              .locator(
                '.chat-virtual-row[data-virtual-row-key^="agent-run:"][data-virtual-row-key*="long-active-run"]',
              )
              .first()
              .evaluate((element) => element.getBoundingClientRect().height);
            await thread.hover();
            await reader.mouse.wheel(0, mode === "near-bottom" ? -80 : -activeHeight - 350);
            await waitForChatScrollIdle(reader);
          }
          const dir = createControlUiE2eArtifactDir("two-client-scroll-" + mode);
          const before = await thread.evaluate((element) => {
            const viewport = element.getBoundingClientRect();
            const bubbles = [
              ...element.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]"),
            ];
            const anchor = bubbles.find((bubble) => {
              const rect = bubble.getBoundingClientRect();
              return rect.top >= viewport.top + 1 && rect.bottom <= viewport.bottom - 1;
            });
            if (!anchor) {
              throw new Error("Expected a fully visible reading anchor");
            }
            return {
              top: element.scrollTop,
              anchorId: anchor.dataset.messageId!,
              anchorTop: anchor.getBoundingClientRect().top - viewport.top,
              text: anchor.textContent?.replace(/\s+/gu, " ").trim().slice(0, 70),
              distance: element.scrollHeight - element.clientHeight - element.scrollTop,
            };
          });
          if (mode === "older-history") {
            expect(before.text).toContain("Earlier");
          }
          if (mode === "near-bottom") {
            expect(before.distance).toBeGreaterThan(8);
          }
          await reader.screenshot({ path: path.join(dir, "before-remote-send.png") });
          await thread.evaluate((element, anchorId) => {
            let frame = 0;
            const samples: Array<{ top: number; anchor: number | null }> = [];
            const sample = () => {
              const bubble = element.querySelector<HTMLElement>(
                '[data-message-id="' + CSS.escape(anchorId) + '"]',
              );
              samples.push({
                top: element.scrollTop,
                anchor: bubble
                  ? bubble.getBoundingClientRect().top - element.getBoundingClientRect().top
                  : null,
              });
              frame = requestAnimationFrame(sample);
            };
            Object.assign(element, {
              anchorSamples: samples,
              stopAnchorSamples: () => cancelAnimationFrame(frame),
            });
            frame = requestAnimationFrame(sample);
          }, before.anchorId);
          const checkpoints: Array<{
            stage: string;
            top: number;
            anchor: number | null;
            distance: number;
            keys: string[];
          }> = [];
          const checkpoint = async (stage: string) => {
            await reader.evaluate(
              () =>
                new Promise<void>((resolve) => {
                  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                }),
            );
            await waitForChatScrollIdle(reader);
            checkpoints.push(
              await thread.evaluate(
                (element, args) => {
                  const bubble = element.querySelector<HTMLElement>(
                    '[data-message-id="' + CSS.escape(args.anchorId) + '"]',
                  );
                  return {
                    stage: args.stage,
                    top: element.scrollTop,
                    anchor: bubble
                      ? bubble.getBoundingClientRect().top - element.getBoundingClientRect().top
                      : null,
                    distance: element.scrollHeight - element.clientHeight - element.scrollTop,
                    keys: [...element.querySelectorAll<HTMLElement>(".chat-virtual-row")].map(
                      (row) => row.dataset.virtualRowKey!,
                    ),
                  };
                },
                { stage, anchorId: before.anchorId },
              ),
            );
          };
          await senderGateway.deferNext("chat.send");
          const prompt = "Please also check the shared components.";
          await sender.locator(".agent-chat__composer-combobox textarea").fill(prompt);
          await sender.getByRole("button", { name: /^(Send|Queue) message$/ }).click();
          const request = requireRecord((await senderGateway.waitForRequest("chat.send")).params);
          expect(request.message).toBe(prompt);
          expect(request.sessionKey).toBe(sessionKey);
          const sendId = requireString(request.idempotencyKey, "second-client send identity");
          const pendingMessage = {
            role: "user",
            content: prompt,
            timestamp: Date.now(),
            __openclaw: { id: "pending:" + sendId, ...attribution(people[1]!) },
          };
          const pending = {
            id: sendId,
            runId: sendId,
            acceptedAt: pendingMessage.timestamp,
            state: "queued",
            message: pendingMessage,
          };
          // The fixture relays the actual sender request to both independent clients.
          // It is not a production Gateway or an authenticated multi-user backend.
          const clients = [readerGateway, senderGateway];
          await Promise.all(
            clients.map((gateway) =>
              gateway.setMethodResponse("chat.history", {
                ...snapshot,
                pendingInputs: { items: [pending], total: 1 },
              }),
            ),
          );
          await senderGateway.resolveDeferred("chat.send", { runId: sendId, status: "queued" });
          const reads = (await readerGateway.getRequests("chat.history")).length;
          await Promise.all(
            clients.map((gateway) =>
              gateway.emitGatewayEvent("sessions.changed", {
                sessionKey,
                agentId: "main",
                reason: "send",
                hasActiveRun: true,
                activeRunIds: [runId],
              }),
            ),
          );
          await expect
            .poll(async () => (await readerGateway.getRequests("chat.history")).length)
            .toBeGreaterThan(reads);
          await checkpoint("accepted");
          const promoted = {
            ...pendingMessage,
            __openclaw: {
              id: "peer-persisted",
              seq: 45,
              idempotencyKey: sendId + ":user",
              ...attribution(people[1]!),
            },
          };
          const nextHistory = [...history, promoted];
          await Promise.all(
            clients.map((gateway) =>
              gateway.setMethodResponse("chat.history", { ...snapshot, messages: nextHistory }),
            ),
          );
          await Promise.all(
            clients.map((gateway) =>
              gateway.emitGatewayEvent("session.message", {
                sessionKey,
                sessionId,
                agentId: "main",
                session,
                message: promoted,
                messageId: "peer-persisted",
                messageSeq: 45,
                clientRunId: sendId,
                hasActiveRun: true,
                activeRunIds: [runId],
              }),
            ),
          );
          await checkpoint("persisted");
          const tail =
            "Streaming continuation. " +
            "A new verified detail expands the current response. ".repeat(15);
          await Promise.all(
            clients.map((gateway) =>
              gateway.emitGatewayEvent("chat", {
                sessionKey,
                runId,
                state: "delta",
                seq: 1,
                message: { role: "assistant", content: tail },
              }),
            ),
          );
          await checkpoint("stream-growth");
          await Promise.all(
            clients.map((gateway) =>
              gateway.setMethodResponse("chat.history", {
                ...snapshot,
                messages: nextHistory,
                inFlightRun: { ...inFlightRun, text: tail },
              }),
            ),
          );
          await readerGateway.emitGatewayEvent("sessions.changed", {
            sessionKey,
            agentId: "main",
            reason: "send",
            hasActiveRun: true,
            activeRunIds: [runId],
          });
          await checkpoint("reconciled");
          await reader.screenshot({ path: path.join(dir, "after-remote-send.png") });
          const samples = await thread.evaluate((element) => {
            const probe = element as HTMLElement & {
              anchorSamples: Array<{ top: number; anchor: number | null }>;
              stopAnchorSamples: () => void;
            };
            probe.stopAnchorSamples();
            return probe.anchorSamples;
          });
          const proof = { mode, before, checkpoints, samples };
          await writeFile(path.join(dir, "scroll-proof.json"), JSON.stringify(proof, null, 2));
          console.log(
            "TWO_CLIENT_SCROLL",
            JSON.stringify({
              mode,
              before,
              checkpoints,
              sampleCount: samples.length,
              maxAnchorDrift: Math.max(
                ...samples.map((sample) =>
                  Math.abs((sample.anchor ?? Number.POSITIVE_INFINITY) - before.anchorTop),
                ),
              ),
            }),
          );
          expect(await readerGateway.getRequests("chat.send")).toHaveLength(0);
          for (const point of checkpoints) {
            expect(new Set(point.keys).size, point.stage).toBe(point.keys.length);
            expect(
              Math.abs((point.anchor ?? Number.POSITIVE_INFINITY) - before.anchorTop),
              point.stage,
            ).toBeLessThanOrEqual(1);
          }
          for (const sample of samples) {
            expect(
              Math.abs((sample.anchor ?? Number.POSITIVE_INFINITY) - before.anchorTop),
            ).toBeLessThanOrEqual(1);
          }
        });
      });
    },
  );
});
