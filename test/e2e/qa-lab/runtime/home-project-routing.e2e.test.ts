import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { createTrackedProvider } from "../../../../src/gateway/test-helpers.tracked-provider.js";
import { respondJson } from "../../../helpers/gateway-integration-fixtures.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { runQaGatewayTestFixture } from "../../../helpers/qa-gateway-test-lifetime.js";
import { messageText, sendChat, waitForRun } from "./gateway-recovery.test-support.js";
import { nativeModel, writeNativeCompletion } from "./native-provider-proof-fixture.js";

it(
  "routes Home project work into its own checkout without implicitly moving Home",
  { timeout: 180_000 },
  async (test) => {
    const home = "agent:qa:main";
    const ordinary = "agent:qa:dashboard:routing-control";
    const request = "Let's work on Juniper.";
    const modelId = "project-local";
    const model = `mock-openai/${modelId}`;
    let pendingRequest: string | undefined;
    let stale = false;
    let projectId = "";
    let action = "";
    let handoff = "";
    const provider = createTrackedProvider((raw, response, incoming) => {
      if (incoming.method === "GET") {
        return respondJson(response, { data: [{ id: modelId, object: "model" }] });
      }
      const body: {
        messages: { role: string; content: unknown }[];
        tools?: {
          function: { name: string; parameters: { properties: { action?: { enum?: string[] } } } };
        }[];
      } = JSON.parse(raw);
      const system = body.messages
        .filter((m) => m.role === "system" || m.role === "developer")
        .map(messageText)
        .join("\n");
      const userText = body.messages.filter((m) => m.role === "user").map(messageText);
      for (const message of body.messages) {
        const receipt = messageText(message)
          .split("\n")
          .find((line) =>
            /Conversation move result|nothing was moved|checkout was not allocated/i.test(line),
          );
        if (receipt) {
          handoff = receipt.slice(0, 700);
        }
      }
      const wanted = pendingRequest;
      if (wanted && body.tools?.length && userText.some((text) => text.includes(wanted))) {
        pendingRequest = undefined;
        const move = stale || system.includes("call session_project with action move");
        if (!stale) {
          expect(system).toContain(JSON.stringify({ id: projectId, name: "Juniper" }));
        }
        action = move ? "session_project" : "sessions_spawn";
        if (!stale) {
          expect(body.tools.map((t) => t.function.name)).toContain(action);
          if (!move) {
            expect(system).toContain("separate project session");
            expect(
              body.tools.find((t) => t.function.name === "session_project")?.function.parameters
                .properties.action?.enum,
            ).toEqual(["list"]);
          }
        }
        const args = move
          ? { action: "move", projectId }
          : {
              task: "Report project readiness.",
              label: "Juniper readiness",
              visible: true,
              projectId,
              worktree: true,
            };
        return writeNativeCompletion(
          response,
          "route",
          modelId,
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: stale ? "retained-call" : "route-call",
                type: "function",
                function: { name: action, arguments: JSON.stringify(args) },
              },
            ],
          },
          "tool_calls",
        );
      }
      writeNativeCompletion(response, "reply", modelId, "Juniper fixture ready.");
    });
    const owner = createQaGatewayChild();
    await runQaGatewayTestFixture(
      test,
      async () => {
        const baseUrl = await provider.listen();
        const gateway = await owner.start({
          repoRoot: process.cwd(),
          // Allocate on the checkout's filesystem; small tmpfs mounts cannot satisfy the
          // managed-worktree owner's disk reserve, even for this tiny project.
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.resolve("dist/index.js")],
            tempParentDir: path.resolve(".artifacts"),
          },
          providerBaseUrl: baseUrl,
          transportBaseUrl: "http://127.0.0.1",
          providerMode: "mock-openai",
          primaryModel: model,
          alternateModel: model,
          forcedRuntime: "openclaw",
          controlUiEnabled: false,
          mutateConfig: (cfg) => ({
            ...cfg,
            plugins: { allow: ["openai"], slots: { memory: "none" } },
            agents: {
              ...cfg.agents,
              defaults: {
                ...cfg.agents?.defaults,
                skills: [],
                skipBootstrap: true,
                heartbeat: { every: "0m" },
              },
            },
            models: {
              mode: "replace",
              providers: {
                "mock-openai": {
                  api: "openai-completions",
                  baseUrl,
                  auth: "none",
                  request: { allowPrivateNetwork: true },
                  models: [nativeModel(modelId)],
                },
              },
            },
            tools: {
              allow: ["session_project", "sessions_spawn", "read"],
              codeMode: { enabled: false },
              toolSearch: { enabled: false },
            },
          }),
        });
        const repo = path.join(gateway.tempRoot, "juniper");
        await fs.mkdir(repo);
        execFileSync("git", ["init", "-b", "main", repo]);
        await fs.writeFile(path.join(repo, "project-marker.txt"), "Juniper checkout");
        execFileSync("git", ["-C", repo, "add", "project-marker.txt"]);
        execFileSync("git", [
          "-C",
          repo,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-m",
          "Juniper base",
        ]);
        const project = (await gateway.call("projects.register", {
          path: repo,
          name: "Juniper",
        })) as { id: string };
        projectId = project.id;
        const row = async (key: string) =>
          (
            (await gateway.call("sessions.describe", { key })) as {
              session: {
                key: string;
                sessionId: string;
                isMain?: boolean;
                projectId?: string;
                worktree?: { id: string };
              };
            }
          ).session;
        const trees = async () =>
          (
            (await gateway.call("worktrees.list", {})) as {
              worktrees: { id: string; ownerId?: string; path: string }[];
            }
          ).worktrees;
        const send = async (key: string, text: string) => {
          const run = await sendChat(gateway, key, text);
          await expect
            .poll(async () => (await waitForRun(gateway, run.runId)).status, {
              timeout: 45_000,
              interval: 250,
              message: text,
            })
            .toBe("ok");
        };
        await send(home, "Hello from Home.");
        const before = await row(home);
        expect(before.key).toBe(home);
        expect(before.sessionId).toBeTruthy();
        expect(before.isMain).toBe(true);
        const homeFiles = () => gateway.call("sessions.files.list", { sessionKey: home, path: "" });
        await expect(homeFiles()).resolves.toMatchObject({ root: gateway.workspaceDir });
        expect(before.worktree).toBeUndefined();
        pendingRequest = request;
        await send(home, request);
        expect(pendingRequest).toBeUndefined();
        await expect
          .poll(async () => (await trees()).length || handoff, { timeout: 30_000 })
          .toBe(1);
        const [childTree] = await trees();
        expect.assert(childTree);
        if (childTree.ownerId === home) {
          // Wait for the binding commit, not merely the checkout allocation, on the red path.
          await expect.poll(async () => (await row(home)).worktree?.id).toBe(childTree.id);
          await expect(homeFiles()).resolves.toMatchObject({ root: childTree.path });
          expect(await row(home)).toMatchObject({ sessionId: before.sessionId, projectId });
        }
        expect(
          childTree.ownerId,
          "the model routed project work into Home's own checkout",
        ).not.toBe(home);
        expect(action).toBe("sessions_spawn");
        expect.assert(childTree.ownerId);
        expect(await row(childTree.ownerId)).toMatchObject({
          projectId,
          worktree: { id: childTree.id },
        });
        await expect(
          gateway.call("sessions.files.get", {
            sessionKey: childTree.ownerId,
            path: "project-marker.txt",
          }),
        ).resolves.toMatchObject({ root: childTree.path, file: { content: "Juniper checkout" } });
        const assertHome = async () => {
          const after = await row(home);
          expect(after.sessionId).toBe(before.sessionId);
          await expect(homeFiles()).resolves.toMatchObject({ root: gateway.workspaceDir });
          expect(after.projectId).toBe(before.projectId);
          expect(after.worktree).toBeUndefined();
          expect((await trees()).some((t) => t.ownerId === home)).toBe(false);
        };
        await assertHome();
        stale = true;
        pendingRequest = "Replay the old tool call.";
        await send(home, pendingRequest);
        expect(pendingRequest).toBeUndefined();
        await assertHome();
        stale = false;
        await gateway.call("sessions.create", {
          agentId: "qa",
          key: ordinary,
          label: "Ordinary control",
        });
        // A late Home follow-up still contains its earlier request; only this turn
        // may consume the ordinary-session control.
        pendingRequest = "Let’s work on Juniper in this conversation.";
        await send(ordinary, pendingRequest);
        expect(pendingRequest).toBeUndefined();
        expect(action).toBe("session_project");
        await expect
          .poll(async () => (await row(ordinary)).projectId ?? handoff, { timeout: 30_000 })
          .toBe(projectId);
        await assertHome();
        expect(
          await gateway.call("projects.moveSessionOptions", { sessionKey: home }),
        ).toMatchObject({ available: true });
        expect(
          await gateway.call("projects.moveSession", { sessionKey: home, projectId }),
        ).toMatchObject({ status: "moved", projectId });
        expect(await row(home)).toMatchObject({ sessionId: before.sessionId, projectId });
      },
      () => stopQaGatewayFixture(owner),
      () => provider.close(),
    );
  },
);
