import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createGatewayMethodRegistry } from "../../gateway/methods/registry.js";
import { NodeRegistry } from "../../gateway/node-registry.js";
import { presenceHandlers } from "../../gateway/server-methods/presence.js";
import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import { createContext } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../cron-creator-authority-context.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createPresenceTool } from "./presence-tool.js";

function fixture(locationHandler?: GatewayRequestHandler) {
  const context = createContext();
  const snapshot = vi.fn(() => [
    {
      ts: 1,
      reason: "connect",
      connectionId: "ada-connection",
      deviceId: "ada-laptop",
      ip: "203.0.113.2",
      user: { id: "ada", name: "Ada", identity: { type: "profile" as const, id: "ada" } },
    },
  ]);
  context.getPresenceSnapshot = snapshot;
  context.nodeRegistry = new NodeRegistry();
  context.getGatewayMethodRegistry = () =>
    createGatewayMethodRegistry([
      {
        name: "presence.query",
        scope: "operator.read",
        owner: { kind: "core", area: "presence" },
        profileAccess: "required",
        handler: presenceHandlers["presence.query"]!,
      },
      ...(locationHandler
        ? [
            {
              name: "geolocation.lookup",
              scope: "operator.read" as const,
              owner: { kind: "plugin" as const, pluginId: "geolocation" },
              handler: locationHandler,
            },
          ]
        : []),
    ]);

  async function run<T>(
    operatorAuthority: AdmittedRunOperatorAuthority | undefined,
    callback: (close: () => void) => Promise<T>,
    admissionSource?: AdmittedRunContext["admissionSource"],
  ): Promise<T> {
    const operationalRunInstance = createOperationalRunInstanceRef("presence-channel-run");
    const prepared = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance,
      operatorAuthority,
      admissionSource,
      facts: {
        runId: operationalRunInstance.runId,
        agentId: "main",
        ingress: { kind: "system", boundary: "presence-test", state: "present" },
      },
    });
    const admitted = await prepared.admit("embedded");
    const approvalAuthority = getAdmittedRunDelegatedAuthority(admitted)!;
    try {
      return await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:discord:direct:requester",
          turnSourceChannel: "discord",
          operationalRunInstance,
          approvalAuthority,
          operatorAuthority,
          receiptAuthority: () => true,
          gatewayContextResolver: () => context,
        },
        () => callback(prepared.close),
      );
    } finally {
      prepared.close();
    }
  }
  return { snapshot, run };
}

describe("presence tool source authority", () => {
  it("rejects an admitted channel turn without operator authority before reading presence", async () => {
    const { run, snapshot } = fixture();
    await expect(run(undefined, () => createPresenceTool().execute("unknown", {}))).rejects.toThrow(
      /presence.*authority|presence.*authenticated|presence.*operator/i,
    );
    expect(snapshot).not.toHaveBeenCalled();
  });

  it.each([{ kind: "local" }, { kind: "external", channel: "discord" }] as const)(
    "allows the captured $kind owner only while its source remains current",
    async (origin) => {
      const { run, snapshot } = fixture();
      let current = true;
      const capability = createCronCreatorAuthorityCapability(
        "presence-channel-run",
        origin,
        origin.kind === "external"
          ? { source: "channel-owner", isCurrent: () => current }
          : undefined,
        () => current,
      )!;
      await run(undefined, async () => {
        await runWithCronCreatorAuthorityCapability(capability, async () => {
          const tool = createPresenceTool({ runId: "presence-channel-run" });
          expect((await tool.execute("owner", {})).details).toMatchObject({
            people: [{ name: "Ada" }],
          });
          current = false;
          await expect(tool.execute("revoked-owner", {})).rejects.toThrow(/authority|source/i);
        });
      });
      expect(snapshot).toHaveBeenCalledOnce();
    },
  );

  it.each(["operator-schedule", "requester-schedule"] as const)(
    "uses the admitted %s source without promoting requester schedules",
    async (source) => {
      const { run, snapshot } = fixture();
      await run(
        undefined,
        async (close) => {
          const tool = createPresenceTool();
          const pending = tool.execute("scheduled", {});
          if (source === "operator-schedule") {
            expect((await pending).details).toMatchObject({ people: [{ name: "Ada" }] });
            close();
            await expect(tool.execute("expired-schedule", {})).rejects.toThrow(/authority|source/i);
            expect(snapshot).toHaveBeenCalledOnce();
          } else {
            await expect(pending).rejects.toThrow(
              "Presence requires authenticated Gateway read access",
            );
            expect(snapshot).not.toHaveBeenCalled();
          }
        },
        source,
      );
    },
  );

  it.each([
    { scopes: ["operator.read"], allowed: true },
    { scopes: ["operator.write"], allowed: true },
    { scopes: ["operator.sessions.write"], allowed: false },
    { scopes: [], allowed: false },
  ])("uses the original non-owner scopes $scopes", async ({ scopes, allowed }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("presence-reader@example.test");
      const authority = createAdmittedRunOperatorAuthority({
        profileId: profile.id,
        scopes,
        assertCurrent: () => {},
      });
      const { run, snapshot } = fixture();
      const pending = run(authority, () => createPresenceTool().execute("reader", {}));
      if (allowed) {
        expect((await pending).details).toMatchObject({ people: [{ name: "Ada" }] });
        expect(snapshot).toHaveBeenCalledOnce();
      } else {
        await expect(pending).rejects.toThrow(/operator\.read|presence.*authority/i);
        expect(snapshot).not.toHaveBeenCalled();
      }
    });
  });

  it("withholds a delayed location result after the original operator is revoked", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("presence-reader@example.test");
      let current = true;
      const authority = createAdmittedRunOperatorAuthority({
        profileId: profile.id,
        scopes: ["operator.read"],
        assertCurrent: () => {
          if (!current) {
            throw new Error("presence reader revoked");
          }
        },
      });
      const entered = createDeferred();
      const release = createDeferred();
      const { run, snapshot } = fixture(async ({ respond }) => {
        entered.resolve();
        await release.promise;
        respond(true, { results: [] });
      });
      const pending = run(authority, () =>
        createPresenceTool().execute("location", { include: ["location"] }),
      );
      const rejected = expect(pending).rejects.toThrow(
        "operator execution authority is no longer active",
      );
      await entered.promise;
      current = false;
      release.resolve();
      await rejected;
      expect(snapshot).toHaveBeenCalledOnce();
    });
  });
});
