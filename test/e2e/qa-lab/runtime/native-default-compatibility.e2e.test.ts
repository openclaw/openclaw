import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { createDeferred } from "../../../helpers/promise.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  closeNativeProvider,
  createNativeProvider,
  listenNativeProvider,
  nativeModel,
  writeNativeCompletion,
} from "./native-provider-proof-fixture.js";
import {
  createSkillLibraryWireInstance,
  SKILL_LIBRARY_ALICE,
  SKILL_LIBRARY_BOB,
  SkillLibraryWireClient,
} from "./skill-library-wire-fixture.js";

// Release-tier proof: separate real Gateway processes/state/auth/ports, not two
// in-process Gateway singletons. Provider HTTP is a credential-checking fixture.
it(
  "isolates concurrent credentials and Skills for two users on each of two Gateways",
  { timeout: 240_000 },
  async () => {
    const instances: Awaited<ReturnType<typeof createSkillLibraryWireInstance>>[] = [];
    const clients: SkillLibraryWireClient[] = [];
    const providerErrors: unknown[] = [];
    let requestCount = 0;
    let entered = 0;
    const gate = createDeferred();
    const credential = (gateway: number, user: string) => `synthetic-compat-${gateway}-${user}`;
    const instruction = (gateway: number, user: string) => `COMPAT_SKILL_${gateway}_${user}`;
    const servers = [0, 1].map((gateway) =>
      createNativeProvider(
        async (request, response, rawBody) => {
          if (request.url !== "/v1/chat/completions") {
            response.writeHead(404).end();
            return;
          }
          const body = JSON.parse(rawBody) as {
            model: string;
            messages: Array<{ role: string; content?: unknown }>;
            tools?: Array<{ function?: { name: string } }>;
          };
          const user = body.model.replace("compat-", "");
          expect(["alice", "bob"]).toContain(user);
          expect(request.headers.authorization).toBe("Bearer " + credential(gateway, user));
          const toolMessage = body.messages.findLast((message) => message.role === "tool");
          requestCount++;
          let delta: Record<string, unknown>;
          let finish: string;
          if (!toolMessage) {
            entered += 1;
            if (entered === 4) {
              gate.resolve();
            }
            await gate.promise;
            const name = body.tools?.find((candidate) => candidate.function?.name === "exec")
              ?.function?.name;
            expect(name).toBe("exec");
            delta = {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "compat-read",
                  type: "function",
                  function: {
                    name,
                    arguments: JSON.stringify({
                      title: "Read owned skill",
                      code: 'return await skills.read("guide");',
                    }),
                  },
                },
              ],
            };
            finish = "tool_calls";
          } else {
            const output = JSON.stringify(toolMessage.content);
            expect(output).toContain(instruction(gateway, user));
            for (const otherGateway of [0, 1]) {
              for (const otherUser of ["alice", "bob"]) {
                if (otherGateway !== gateway || otherUser !== user) {
                  expect(output).not.toContain(instruction(otherGateway, otherUser));
                }
              }
            }
            delta = { role: "assistant", content: instruction(gateway, user) + "_OK" };
            finish = "stop";
          }
          writeNativeCompletion(response, "compat-response", body.model, delta, finish);
        },
        (error, response) => {
          providerErrors.push(error);
          response.writeHead(500).end("fixture contract failed");
          gate.resolve();
        },
      ),
    );
    await runQaGatewayFixture(
      async () => {
        for (const [gateway, server] of servers.entries()) {
          const baseUrl = await listenNativeProvider(server);
          const instance = await createSkillLibraryWireInstance();
          instances.push(instance);
          // Drop inherited credentials; retain only fixture state and OS launch inputs.
          const allowed = new Set([
            ...Object.keys(instance.state.envVars),
            ...(
              "PATH Path SystemRoot SYSTEMROOT WINDIR ComSpec COMSPEC PATHEXT TMPDIR TMP TEMP LANG LC_ALL " +
              "OPENCLAW_BUILD_PRIVATE_QA OPENCLAW_SKIP_GMAIL_WATCHER OPENCLAW_SKIP_CRON " +
              "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER OPENCLAW_SKIP_CANVAS_HOST"
            ).split(" "),
          ]);
          for (const key of Object.keys(instance.env)) {
            if (!allowed.has(key)) {
              delete instance.env[key];
            }
          }
          const config = JSON.parse(
            await fs.readFile(instance.configPath, "utf8"),
          ) as OpenClawConfig;
          config.plugins = {
            allow: ["openai"],
            entries: { openai: { enabled: true } },
            slots: { memory: "none" },
          };
          config.models = {
            mode: "replace",
            providers: {
              "mock-openai": {
                baseUrl,
                api: "openai-completions",
                models: ["alice", "bob"].map((user) =>
                  nativeModel("compat-" + user, { name: user }),
                ),
              },
            },
          };
          config.tools = { codeMode: true };
          config.agents = {
            ownership: "explicit",
            defaults: {
              workspace: instance.state.workspaceDir,
              model: "mock-openai/compat-alice",
              modelPolicy: {
                allow: ["alice", "bob"].map((user) => "mock-openai/compat-" + user),
              },
            },
            entries: {},
          };
          for (const user of ["alice", "bob"]) {
            const workspace = path.join(instance.state.workspaceDir, user);
            await fs.mkdir(path.join(workspace, "skills/guide"), { recursive: true });
            await fs.writeFile(
              path.join(workspace, "skills/guide/SKILL.md"),
              `---\nname: guide\ndescription: owned fixture\n---\n${instruction(gateway, user)}`,
            );
            config.agents.entries![user] = {
              workspace,
              agentDir: instance.state.agentDir(user),
              model: "mock-openai/compat-" + user,
              modelPolicy: { allow: ["mock-openai/compat-" + user] },
            };
            await instance.state.writeAuthProfiles(
              {
                version: 1,
                profiles: {
                  "mock-openai:compat": {
                    type: "api_key",
                    provider: "mock-openai",
                    key: credential(gateway, user),
                  },
                },
                order: { "mock-openai": ["mock-openai:compat"] },
              },
              user,
            );
          }
          await instance.state.writeConfig(config);
        }
        expect(instances[0]!.port).not.toBe(instances[1]!.port);
        expect(instances[0]!.stateDir).not.toBe(instances[1]!.stateDir);
        expect(instances[0]!.gatewayToken).not.toBe(instances[1]!.gatewayToken);
        await Promise.all(instances.map((instance) => instance.startGateway()));
        const connections: Array<{
          gateway: number;
          user: string;
          client: SkillLibraryWireClient;
        }> = [];
        for (const [gateway, instance] of instances.entries()) {
          const admin = await SkillLibraryWireClient.connect(instance);
          clients.push(admin.client);
          for (const [user, email] of [
            ["alice", SKILL_LIBRARY_ALICE],
            ["bob", SKILL_LIBRARY_BOB],
          ] as const) {
            const connected = await SkillLibraryWireClient.connect(instance, {
              email,
              buildId: admin.hello.server.buildId,
            });
            clients.push(connected.client);
            connections.push({
              gateway,
              user,
              client: connected.client,
            });
          }
        }
        await expect(
          SkillLibraryWireClient.connect({
            ...instances[0]!,
            gatewayToken: instances[1]!.gatewayToken,
          }),
        ).rejects.toThrow();
        await Promise.all(
          connections.map(async (owner) => {
            // Same agent/session ids and relative Skill paths intentionally recur on both Gateways.
            const key = "agent:" + owner.user + ":compat";
            await owner.client.request("sessions.create", {
              key,
              agentId: owner.user,
              displayName: "Compatibility proof",
            });
            const started = await owner.client.request<{ runId: string }>("chat.send", {
              sessionKey: key,
              message: "Read the guide Skill, then report its marker.",
              deliver: false,
              idempotencyKey: "compat-" + owner.user,
            });
            expect(
              await owner.client.request(
                "agent.wait",
                { runId: started.runId, timeoutMs: 60_000 },
                65_000,
              ),
            ).toMatchObject({ status: "ok" });
            const history = await owner.client.request<{ messages: unknown[] }>("chat.history", {
              sessionKey: key,
              limit: 50,
            });
            expect(JSON.stringify(history.messages)).toContain(
              instruction(owner.gateway, owner.user) + "_OK",
            );
          }),
        );
        expect(requestCount).toBe(connections.length * 2);
        expect(providerErrors).toEqual([]);
      },
      () => gate.resolve(),
      async () => {
        await Promise.all(clients.map((client) => client.close()));
      },
      async () => {
        await Promise.all(instances.map((instance) => instance.cleanup()));
      },
      async () => {
        await Promise.all(servers.map(closeNativeProvider));
      },
    );
  },
);
