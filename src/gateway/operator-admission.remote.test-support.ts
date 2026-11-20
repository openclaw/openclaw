import { randomUUID } from "node:crypto";
import { assert } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { GatewayControlUiIngressV2 } from "../plugins/gateway-ingress.types.js";
import { WRITER } from "./operator-admission.credentials.test-support.js";
import type { LiveAdmissionProducer } from "./operator-admission.live.test-support.js";
import type { AdmissionFixture } from "./operator-admission.table.test-support.js";
import { getGatewayControlUiIngressHost } from "./remote-control-ui-ingress-host.js";
import {
  connect,
  expectHello,
  request,
  type IngressFrame,
  type Peer,
} from "./remote-control-ui-ingress.integration.test-support.js";
import { createGatewayControlUiIngressFactory } from "./remote-control-ui-ingress.js";

export type RemoteLiveKind = "live-remote-ingress";

export async function prepareRemoteIngressProducer(
  fixture: AdmissionFixture,
): Promise<LiveAdmissionProducer> {
  const c = fixture.current;
  assert(c && fixture.kernel);
  assert(fixture.config.gateway?.auth?.mode === "token", "Remote rotation uses the token pool");
  const ownerConfig = structuredClone(fixture.config);
  delete ownerConfig.gateway!.roles;
  await fixture.publish(ownerConfig, c.signal);
  const host = getGatewayControlUiIngressHost(fixture.kernel.resolvePluginGatewayContext);
  assert(host, "The running Gateway must own the remote ingress transport");
  const factory = createGatewayControlUiIngressFactory({
    pluginId: `remote-admission-${c.id}`,
    signal: c.service.signal,
    assertCurrent: () => c.service.signal.throwIfAborted(),
    host,
  });
  // Deliberately no recovery registration: the queued source must remain live-only.
  const binding = await factory.bindPrincipal({
    audienceId: c.id,
    principal: { kind: "owner" },
    operatorScopeCeiling: WRITER,
    signal: c.consent.signal,
    assertCurrent: () => c.consent.signal.throwIfAborted(),
  });
  let ingress: GatewayControlUiIngressV2 | undefined;
  let peer: Peer | undefined;
  const release = () =>
    runQaGatewayFixture(
      async () => {
        await peer?.close();
      },
      () => ingress?.close(),
      () => binding.close(),
    );
  try {
    const publicOrigin = "https://remote-admission.example.test";
    ingress = await binding.openControlUi({
      publicOrigin,
      sandboxOrigin: "https://sandbox.remote-admission.example.test",
      frameAncestors: ["https://host.example.test"],
    });
    const { socket } = await ingress.openWebSocket({
      pathAndQuery: host.controlUiBasePath || "/",
      origin: publicOrigin,
      protocols: [],
      signal: c.service.signal,
    });
    const messages = socket.messages[Symbol.asyncIterator]();
    const operator: Peer = {
      send: (frame) => socket.send({ kind: "text", text: JSON.stringify(frame) }),
      read: async () => {
        const frame = await c.wait(messages.next());
        assert(!frame.done && frame.value.kind === "text", "Expected a Gateway JSON frame");
        return JSON.parse(frame.value.text) as IngressFrame;
      },
      close: async () => {
        socket.close();
        await socket.closed;
        await messages.return?.();
      },
    };
    peer = operator;
    expectHello(
      await c.wait(connect(operator, { identity: c.identity, scopes: WRITER })),
      "remote-ingress",
      WRITER,
    );
    const rpc = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      const response = await c.wait(request(operator, method, params));
      assert(response.ok, response.error?.message ?? `Remote ${method} failed`);
      return response.payload as T;
    };
    const self = await rpc<{ profile: { id: string } }>("users.self", {});
    c.profileId = self.profile.id;
    await replaceSessionEntry(c.target, {
      sessionId: c.target.sessionId,
      updatedAt: Date.now(),
      createdActor: { type: "human", source: "profile", id: c.profileId },
    });
    return {
      send: (params) => rpc<{ runId: string }>("chat.send", params),
      revoke: async () => {
        // Rotate exactly the shared credential owner. Consent, profile and device
        // still authorize this remote-ingress connection and its accepted input.
        const rotated = structuredClone(fixture.config);
        assert(rotated.gateway?.auth?.mode === "token");
        rotated.gateway.auth.token = randomUUID();
        await fixture.publish(rotated, c.signal);
      },
      release,
    };
  } catch (error) {
    return await runQaGatewayFixture(async (): Promise<never> => {
      throw error;
    }, release);
  }
}
