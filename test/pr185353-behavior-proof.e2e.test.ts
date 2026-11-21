import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { buildQaGatewayConfig } from "../extensions/qa-lab/api.js";
import { startHeldResponsesProvider } from "./e2e/qa-lab/runtime/held-responses-provider.js";
import {
  createSkillLibraryWireInstance,
  SKILL_LIBRARY_ALICE,
  SKILL_LIBRARY_BOB,
  SKILL_LIBRARY_WRITER_SCOPES,
  SkillLibraryWireClient,
} from "./e2e/qa-lab/runtime/skill-library-wire-fixture.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const MODEL_REF = "openai/gpt-5.6-sol";

type Self = { profile: { id: string } };
type SessionRow = { key?: string };
type SessionList = { sessions?: SessionRow[]; people?: Array<{ identity?: { id?: string } }> };

it(
  "proves a distinct WebChat participant is recorded only after busy admission completes",
  { timeout: 180_000 },
  async () => {
    const instance = await createSkillLibraryWireInstance();
    const provider = await startHeldResponsesProvider({
      modelRef: MODEL_REF,
      terminalText: "local busy proof reply",
    });
    const clients: SkillLibraryWireClient[] = [];
    await runQaGatewayFixture(
      async () => {
        const config = buildQaGatewayConfig({
          bind: "loopback",
          gatewayPort: instance.port,
          gatewayToken: instance.gatewayToken,
          workspaceDir: instance.state.workspaceDir,
          providerBaseUrl: `${provider.baseUrl}/v1`,
          providerMode: "mock-openai",
          primaryModel: MODEL_REF,
          alternateModel: MODEL_REF,
          controlUiEnabled: false,
          enabledPluginIds: ["openai"],
        });
        const authConfig = JSON.parse(await fs.readFile(instance.configPath, "utf8")) as {
          gateway: typeof config.gateway;
        };
        config.gateway = authConfig.gateway;
        await instance.state.writeConfig(config);
        await instance.startGateway();

        const bootstrap = await SkillLibraryWireClient.connect(instance);
        clients.push(bootstrap.client);
        const connect = async (email: string, admin = false) => {
          const connected = await SkillLibraryWireClient.connect(instance, {
            email,
            buildId: bootstrap.hello.server.buildId,
            scopes: admin ? ["operator.admin", ...SKILL_LIBRARY_WRITER_SCOPES] : undefined,
          });
          clients.push(connected.client);
          return connected.client;
        };
        const alice = await connect(SKILL_LIBRARY_ALICE, true);
        const bob = await connect(SKILL_LIBRARY_BOB);
        const aliceSelf = await alice.request<Self>("users.self", {});
        const bobSelf = await bob.request<Self>("users.self", {});
        expect(aliceSelf.profile.id).not.toBe(bobSelf.profile.id);

        const sessionKey = `agent:qa:pr185353-${randomUUID()}`;
        await alice.request("sessions.create", {
          key: sessionKey,
          agentId: "qa",
          displayName: "PR 185353 busy participant proof",
          visibility: "shared",
          permissionMode: "full",
          worktree: false,
          cwd: instance.state.workspaceDir,
        });
        const involving = () =>
          bob.request<SessionList>("sessions.list", {
            profileRelation: { profileId: bobSelf.profile.id, relationship: "involving" },
            includePeople: true,
            includeGlobal: true,
            limit: 100,
          });
        const before = await involving();
        expect(before.sessions?.some((row) => row.key === sessionKey)).toBe(false);

        const firstRunId = `pr185353-first-${randomUUID()}`;
        const busyRunId = `pr185353-busy-${randomUUID()}`;
        const first = await alice.request<{ runId: string; status: string }>("chat.send", {
          sessionKey,
          message: "Alice holds reply admission busy",
          deliver: false,
          idempotencyKey: firstRunId,
        });
        expect(first).toMatchObject({ runId: firstRunId, status: "started" });
        await vi.waitFor(() => expect(provider.requests).toHaveLength(1), {
          timeout: 30_000,
          interval: 25,
        });
        const busyParams = {
          sessionKey,
          message: "Bob persisted input accepted while admission is busy",
          deliver: false,
          idempotencyKey: busyRunId,
        };
        const busy = await bob.request<{ runId: string; status: string }>("chat.send", busyParams);
        expect(busy).toMatchObject({ runId: busyRunId, status: "started" });
        const during = await involving();
        expect(during.sessions?.some((row) => row.key === sessionKey)).toBe(false);
        const busyBeforeRelease = await bob.request<{ status: string }>("agent.wait", {
          runId: busyRunId,
          timeoutMs: 100,
        });
        const providerRequestsBeforeRelease = provider.requests.length;
        expect(["pending", "timeout"]).toContain(busyBeforeRelease.status);
        expect(providerRequestsBeforeRelease).toBe(1);

        provider.release();
        await expect(
          alice.request("agent.wait", { runId: firstRunId, timeoutMs: 30_000 }),
        ).resolves.toMatchObject({ status: "ok" });
        await vi.waitFor(
          async () => {
            await expect(
              bob.request("agent.wait", { runId: busyRunId, timeoutMs: 1_000 }),
            ).resolves.toMatchObject({ status: "ok" });
          },
          { timeout: 30_000, interval: 100 },
        );
        const after = await involving();
        expect(after.sessions?.filter((row) => row.key === sessionKey)).toHaveLength(1);
        expect(after.people?.map((person) => person.identity?.id)).toContain(bobSelf.profile.id);

        const providerRequestsAfterBusy = provider.requests.length;
        const duplicate = await bob.request<{ runId: string }>("chat.send", busyParams);
        expect(duplicate.runId).toBe(busyRunId);
        expect(provider.requests).toHaveLength(providerRequestsAfterBusy);
        const history = await bob.request<{ messages: Array<{ role?: string }> }>("chat.history", {
          sessionKey,
          limit: 50,
        });
        expect(history.messages.filter((message) => message.role === "user")).toHaveLength(2);

        console.log(
          JSON.stringify({
            gateway: "real local Gateway",
            clientMode: "authenticated WebChat",
            aliceProfileId: aliceSelf.profile.id,
            bobProfileId: bobSelf.profile.id,
            beforeBusy: before.sessions?.map((row) => row.key) ?? [],
            duringBusy: during.sessions?.map((row) => row.key) ?? [],
            busyBeforeRelease: busyBeforeRelease.status,
            providerRequestsBeforeRelease,
            afterBusy: after.sessions?.map((row) => row.key) ?? [],
            busyRunId,
            duplicateRunId: duplicate.runId,
            providerRequestsAfterBusy,
            persistedUserMessages: history.messages.filter((message) => message.role === "user")
              .length,
          }),
        );
      },
      () => provider.stop(),
      () => clients.toReversed().map((client) => () => client.close()),
      () => instance.cleanup(),
    );
  },
);
