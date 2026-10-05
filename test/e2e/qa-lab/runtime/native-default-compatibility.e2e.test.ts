import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { createDeferred } from "../../../helpers/promise.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  createSkillLibraryWireInstance,
  SKILL_LIBRARY_ALICE,
  SKILL_LIBRARY_BOB,
  SkillLibraryWireClient,
} from "./skill-library-wire-fixture.js";

// Release-tier proof: separate real Gateway processes/state/auth/ports, not two
// in-process Gateway singletons. Provider HTTP is a credential-checking fixture.
it(
  "keeps ordinary streams, identities and Skills isolated in the one/two user and Gateway matrix",
  { timeout: 240_000 },
  async () => {
    const instances: Awaited<ReturnType<typeof createSkillLibraryWireInstance>>[] = [];
    const clients: SkillLibraryWireClient[] = [];
    const providerErrors: unknown[] = [];
    const requests: Array<{ gateway: number; user: string; model: string; continuation: boolean }> =
      [];
    let target = 1;
    let entered = 0;
    let gate = createDeferred();
    const credential = (gateway: number, user: string) =>
      ["synthetic-compat", gateway, user].join("-");
    const instruction = (gateway: number, user: string) =>
      ["COMPAT_SKILL", gateway, user].join("_");
    const servers = [0, 1].map((gateway) =>
      createServer((request, response) => {
        void (async () => {
          if (request.url !== "/v1/chat/completions") {
            response.writeHead(404).end();
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            model: string;
            messages: Array<{ role: string; content?: unknown }>;
            tools?: Array<{ function?: { name: string } }>;
          };
          const user = body.model.replace("compat-", "");
          expect(["alice", "bob"]).toContain(user);
          expect(request.headers.authorization).toBe("Bearer " + credential(gateway, user));
          const toolMessage = body.messages.findLast((message) => message.role === "tool");
          requests.push({
            gateway,
            user,
            model: body.model,
            continuation: Boolean(toolMessage),
          });
          let delta: Record<string, unknown>;
          let finish: string;
          if (!toolMessage) {
            entered += 1;
            if (entered === target) {
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
          response.writeHead(200, { "content-type": "text/event-stream" });
          for (const [part, finishReason] of [
            [delta, null],
            [{}, finish],
          ]) {
            response.write(
              "data: " +
                JSON.stringify({
                  id: "compat-response",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: body.model,
                  choices: [{ index: 0, delta: part, finish_reason: finishReason }],
                }) +
                "\n\n",
            );
          }
          response.end("data: [DONE]\n\n");
        })().catch((error: unknown) => {
          providerErrors.push(error);
          response.writeHead(500).end("fixture contract failed");
          gate.resolve();
        });
      }),
    );
    await runQaGatewayFixture(
      async () => {
        for (const [gateway, server] of servers.entries()) {
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
          });
          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("provider listener unavailable");
          }
          const instance = await createSkillLibraryWireInstance();
          instances.push(instance);
          // Drop inherited credentials; retain only fixture state and OS launch inputs.
          const allowed = new Set([
            ...Object.keys(instance.state.envVars),
            "PATH",
            "Path",
            "SystemRoot",
            "SYSTEMROOT",
            "WINDIR",
            "ComSpec",
            "COMSPEC",
            "PATHEXT",
            "TMPDIR",
            "TMP",
            "TEMP",
            "LANG",
            "LC_ALL",
            "OPENCLAW_BUILD_PRIVATE_QA",
            "OPENCLAW_SKIP_GMAIL_WATCHER",
            "OPENCLAW_SKIP_CRON",
            "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
            "OPENCLAW_SKIP_CANVAS_HOST",
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
                baseUrl: "http://127.0.0.1:" + address.port + "/v1",
                api: "openai-completions",
                models: ["alice", "bob"].map((user) => ({
                  id: "compat-" + user,
                  name: user,
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 32768,
                  maxTokens: 1024,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                })),
              },
            },
          };
          config.tools = { codeMode: true };
          config.agents = {
            defaults: {
              workspace: instance.state.workspaceDir,
              model: "mock-openai/compat-alice",
              models: Object.fromEntries(
                ["alice", "bob"].map((user) => [
                  "mock-openai/compat-" + user,
                  { agentRuntime: { id: "openclaw" } },
                ]),
              ),
            },
            entries: {},
          };
          for (const user of ["alice", "bob"]) {
            const workspace = path.join(instance.state.workspaceDir, user);
            await fs.mkdir(path.join(workspace, "skills/guide"), { recursive: true });
            await fs.writeFile(
              path.join(workspace, "skills/guide/SKILL.md"),
              [
                "---",
                "name: guide",
                "description: owned fixture",
                "---",
                instruction(gateway, user),
              ].join("\n"),
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
          profileId: string;
          buildId: string | undefined;
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
            const self = await connected.client.request<{ profile: { id: string } }>(
              "users.self",
              {},
            );
            expect(connected.hello.auth?.scopes).not.toContain("operator.admin");
            connections.push({
              gateway,
              user,
              client: connected.client,
              profileId: self.profile.id,
              buildId: admin.hello.server.buildId,
            });
          }
        }
        for (const gateway of [0, 1]) {
          const ids = connections
            .filter((connection) => connection.gateway === gateway)
            .map((connection) => connection.profileId);
          expect(new Set(ids).size).toBe(2);
        }
        await expect(
          SkillLibraryWireClient.connect({
            ...instances[0]!,
            gatewayToken: instances[1]!.gatewayToken,
          }),
        ).rejects.toThrow();
        const phases = [[0], [0, 1], [0, 2], [0, 1, 2, 3]];
        for (const [phase, indices] of phases.entries()) {
          target = indices.length;
          entered = 0;
          gate = createDeferred();
          const startCount = requests.length;
          await Promise.all(
            indices.map(async (index) => {
              const owner = connections[index]!;
              // Same agent/session ids and relative Skill paths intentionally recur on both Gateways.
              const key = "agent:" + owner.user + ":compat-" + phase;
              await owner.client.request("sessions.create", {
                key,
                agentId: owner.user,
                displayName: "Compatibility proof",
              });
              const message = {
                sessionKey: key,
                message: "Read the guide Skill, then report its marker.",
                deliver: false,
                idempotencyKey: "compat-" + phase + "-" + owner.user,
              };
              const other = connections.find(
                (connection) =>
                  connection.gateway === owner.gateway && connection.user !== owner.user,
              )!;
              await expect(
                owner.client.request("chat.send", message, 30_000, {
                  expectedProfileId: other.profileId,
                }),
              ).rejects.toMatchObject({
                error: {
                  details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "not_started" },
                },
              });
              const started = await owner.client.request<{ runId: string }>(
                "chat.send",
                message,
                30_000,
                { expectedProfileId: owner.profileId },
              );
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
          expect(providerErrors).toEqual([]);
          expect(requests.slice(startCount)).toHaveLength(indices.length * 2);
          console.log("compatibility matrix cell", {
            gateways: new Set(indices.map((index) => connections[index]!.gateway)).size,
            usersPerGateway: phase === 1 || phase === 3 ? 2 : 1,
            turns: indices.length,
          });
        }
        const alice = connections[0]!;
        await alice.client.close();
        const reconnected = await SkillLibraryWireClient.connect(instances[0]!, {
          email: SKILL_LIBRARY_ALICE,
          buildId: alice.buildId,
        });
        clients.push(reconnected.client);
        expect(await reconnected.client.request("users.self", {})).toMatchObject({
          profile: { id: alice.profileId },
        });
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
        await Promise.all(
          servers.map(
            (server) =>
              new Promise<void>((resolve, reject) => {
                server.closeAllConnections();
                server.close((error) => (error ? reject(error) : resolve()));
              }),
          ),
        );
      },
    );
  },
);
