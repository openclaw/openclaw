import { expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import {
  resolveGatewayToolOperatorSelection,
  withGatewayPersonalToolUser,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

it("retains participant identity for delegated reads but refuses authority mutations before dispatch", async () => {
  const profileId = "participant-source";
  const authority = createAdmittedRunOperatorAuthority({
    profileId,
    scopes: ["operator.admin"],
    assertCurrent() {},
    participationCeiling: {
      kind: "send",
      profileId,
      sessionKey: "agent:main:invited",
      tools: ["*"],
    },
  });
  const handler = vi.fn(({ client, respond }: GatewayRequestHandlerOptions) => {
    expect(client?.internal?.operatorRoleActor).toEqual({ kind: "operator", profileId });
    expect(client?.connect.scopes).toEqual(["operator.read", "operator.admin"]);
    respond(true, { source: profileId });
  });
  const context = createContext([["config.get", "operator.read", "config", handler]]);
  await withGatewayToolCallerIdentity(
    { agentId: "main", sessionKey: "agent:main:invited", operatorAuthority: authority },
    async () => {
      const call = (method: string) =>
        dispatchGatewayMethodInProcess(
          method,
          {},
          {
            forceSyntheticClient: true,
            syntheticScopes: ["operator.read"],
            syntheticScopeMode: "minimum",
            resolveGatewayContext: () => context,
          },
        );
      await expect(call("config.get")).resolves.toEqual({ source: profileId });
      for (const method of [
        "config.set",
        "config.apply",
        "config.patch",
        "plugins.install",
        "plugins.uninstall",
        "plugins.setEnabled",
        "plugins.reload",
        "users.setRole",
        "session.visibility.set",
        "session.members.add",
        "session.members.setAccess",
        "session.members.remove",
        "session.publicShare.set",
        "gateway.restart.request",
        "gateway.stop.request",
        "gateway.suspend.prepare",
        "gateway.suspend.handoff",
        "gateway.suspend.resume",
        "update.run",
        "update.recovery.cleanup",
      ]) {
        await expect(call(method)).rejects.toThrow(
          "Participating tools cannot change Gateway authority",
        );
      }
    },
  );
  expect(handler).toHaveBeenCalledOnce();
  for (const selected of [profileId, "another-participant"]) {
    const selectedAuthority =
      selected === profileId
        ? authority
        : createAdmittedRunOperatorAuthority({
            profileId: selected,
            scopes: ["operator.admin"],
            assertCurrent() {},
          });
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:invited",
        operatorAuthority: authority,
        personalToolParticipants: {
          accept() {},
          close() {},
          resolve: () => ({
            profileId: selected,
            senderId: selected,
            name: selected,
            operatorAuthority: selectedAuthority,
            assertCurrent() {},
          }),
        },
      },
      () =>
        withGatewayPersonalToolUser(selected, () => {
          if (selected === profileId) {
            expect(resolveGatewayToolOperatorSelection().operatorAuthority).toBe(authority);
          } else {
            expect(() => resolveGatewayToolOperatorSelection()).toThrow(
              "Participant tools must use the admitted participant's identity.",
            );
          }
        }),
    );
  }
});
