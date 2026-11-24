import { expect, test } from "vitest";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createSessionsTool } from "../agents/tools/sessions-tool.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { installAuthorityProofKernel } from "./server.agent-runtime-authority-proof.test-support.js";
import { onceMessage, rpcReq } from "./test-helpers.js";

const fixture = installAuthorityProofKernel();

test("an agent rename preserves shared pins only on legacy subscribers", async () => {
  const key = "agent:main:publisher-test";
  const { ws: legacy } = await fixture.harness().openClient({ caps: [] });
  const { ws: personal } = await fixture.harness().openClient({ caps: ["personal-session-pins"] });
  const context = fixture.kernel().gatewayRequestContext;
  const cfg = context.getRuntimeConfig();
  const scope = { context, resolveGatewayContext: () => context, isWebchatConnect: () => false };
  expect(await rpcReq(legacy, "sessions.create", { key, visibility: "shared" })).toMatchObject({
    ok: true,
  });
  const pin = await rpcReq<{ entry: { pinnedAt: number } }>(legacy, "sessions.patch", {
    key,
    pinned: true,
  });
  const pinnedAt = pin.payload?.entry.pinnedAt;
  expect(pinnedAt).toEqual(expect.any(Number));
  for (const ws of [legacy, personal]) {
    expect(await rpcReq(ws, "sessions.subscribe", {})).toMatchObject({ ok: true });
  }
  const label = "Renamed by agent";
  const changed = (ws: typeof legacy) =>
    onceMessage(
      ws,
      (frame) =>
        frame.event === "sessions.changed" &&
        frame.payload?.sessionKey === key &&
        frame.payload?.label === label,
    );
  const [oldClient, newClient, result] = await Promise.all([
    changed(legacy),
    changed(personal),
    withPluginRuntimeGatewayRequestScope(scope, () =>
      withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey: key, gatewayContextResolver: scope.resolveGatewayContext },
        () =>
          createSessionsTool({ config: cfg, agentSessionKey: key }).execute("rename", {
            action: "patch",
            label,
          }),
      ),
    ),
  ]);
  expect(result.details).toMatchObject({ status: "updated" });
  expect(oldClient.payload).toMatchObject({
    pinned: true,
    pinnedAt,
    session: { key, label, pinned: true, pinnedAt },
  });
  expect(newClient.payload).toMatchObject({ session: { key, label } });
  for (const field of ["pinned", "pinnedAt", "session.pinned", "session.pinnedAt"]) {
    expect(newClient.payload).not.toHaveProperty(field);
  }
});
