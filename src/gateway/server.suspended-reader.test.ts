import assert from "node:assert/strict";
import fs from "node:fs/promises";
import pathUtils from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { Value } from "typebox/value";
import { expect, it, vi } from "vitest";
import { HelloOkSchema, type ResponseFrame } from "../../packages/gateway-protocol/src/index.js";
import { loadChatRoute } from "../../ui/src/pages/chat/route-loader.ts";
import { createSessionRouteContext } from "../../ui/src/pages/chat/route-resolution.test-support.ts";
import { isMissingPathError } from "../infra/errors.js";
import { currentSuspension } from "../infra/gateway-suspend-coordinator-state.js";
import {
  onGatewaySuspendAdmissionChange,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as profileReads from "../state/user-profile-reads.js";
import { getGatewayProcessInstanceId } from "./process-instance.js";
import { createGatewaySuspendedReaderFixture } from "./server-close.metadata.test-support.js";
import { gatewayKernelLogs } from "./server-kernel.js";
import type { GatewayReaderReceipt } from "./server-public.js";
import { loadSessionEntry } from "./session-utils.js";

// The frozen plain-JS consumer lives outside the native compiler's source root.
type PairedReader = {
  start: (expiresAtMs: number) => Promise<{
    source: { native: GatewayReaderReceipt };
    manifest: unknown;
    protected: unknown;
  }>;
  assertJoining: () => Promise<void>;
  assertFrozen: () => Promise<void>;
  assertExpired: () => Promise<void>;
  close: () => Promise<void>;
};
type PairedReaderModule = {
  createPairedReaderAssertions: (inputs: {
    native: Awaited<ReturnType<typeof createGatewaySuspendedReaderFixture>>;
    nativeRoot: string;
    nativeRuntimeCommit: string;
    rustTestBinary: string;
    reportPath: string;
  }) => Promise<PairedReader>;
};

// Ordinary native proof and explicit paired source proof share one irreversible lifetime.
it("joins native writer custody before the registered reader receipt and retains authenticated reads until expiry", async () => {
  const rustTestBinary = process.env.TEAMCLAW_PAIRED_READER_RUST_TEST_BINARY;
  const reportPath = process.env.TEAMCLAW_PAIRED_READER_REPORT_PATH;
  const lobsterRoot = process.env.TEAMCLAW_PAIRED_READER_LOBSTER_ROOT;
  const pairedSelected =
    rustTestBinary !== undefined || reportPath !== undefined || lobsterRoot !== undefined;
  if (pairedSelected) {
    assert(
      rustTestBinary && reportPath && lobsterRoot,
      "Selected paired proof requires all frozen artifact inputs",
    );
    expect(pathUtils.resolve(lobsterRoot)).toBe(
      fileURLToPath(new URL("../../../../lobster/teamclaw-release-lobster-16598", import.meta.url)),
    );
  }
  const readerFixture = await createGatewaySuspendedReaderFixture({
    port: 18789,
    ...(pairedSelected ? { roleName: "administrator" } : {}),
  });
  const {
    fixture,
    lock,
    port,
    profile,
    avatarBytes,
    blank,
    sessionKey,
    sessionId,
    shortSessionId,
    shortSessionKey,
    ambiguousKey,
    guestPrincipal,
    missingPrincipal,
    noReadPrincipal,
    privatePassword,
    headers,
    origin,
    open,
    enteredWriterJoin,
    finishWriterJoin,
  } = readerFixture;
  expect(port).toBe(18789);
  const closeErrors = vi.spyOn(gatewayKernelLogs.log, "error");
  let writerSettled = false;
  let paired: PairedReader | undefined;
  try {
    await lock.run(async () => {
      const resolveColdRoute = async (connected: Awaited<ReturnType<typeof open>>) => {
        const { context, request: uiRequest } = createSessionRouteContext();
        assert(Value.Check(HelloOkSchema, connected.hello.payload));
        context.gateway.snapshot.hello = connected.hello.payload;
        uiRequest.mockImplementation(async (method, params) => {
          const frame = await connected.request(method, params);
          if (!frame.ok) {
            throw new Error(frame.error?.message ?? "Gateway read failed");
          }
          return frame.payload;
        });
        const resolved = await loadChatRoute(
          context,
          { pathname: `/chat/main/${shortSessionId.replaceAll("-", "")}`, search: "", hash: "" },
          "chat",
          new AbortController().signal,
        );
        expect(uiRequest).toHaveBeenCalledOnce();
        return resolved;
      };
      const client = await open();
      expect(client.hello.ok, JSON.stringify(client.hello)).toBe(true);
      const self = await client.request("users.self", {});
      expect(self).toMatchObject({ ok: true, payload: { profile: { id: profile.id } } });
      expect(await resolveColdRoute(client)).toMatchObject({
        kind: "session",
        sessionKey: shortSessionKey,
        agentId: "main",
      });
      const accepted = await client.request("chat.history", { sessionKey });
      expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
      expect(JSON.stringify(accepted.payload)).toContain("Retain this accepted turn");
      const labelTarget = { key: sessionKey, agentId: "main", expectedSessionId: sessionId };
      const labelPatch = await client.request("sessions.patch", {
        ...labelTarget,
        label: "Reader mutation baseline",
      });
      expect(labelPatch.ok, JSON.stringify(labelPatch)).toBe(true);
      expect(loadSessionEntry(sessionKey, { agentId: "main" }).entry?.label).toBe(
        "Reader mutation baseline",
      );
      if (pairedSelected) {
        assert(lobsterRoot && rustTestBinary && reportPath);
        const module: PairedReaderModule = await import(
          pathToFileURL(
            pathUtils.join(
              lobsterRoot,
              "src/dev/autodev/software-factory/src/paired-reader.test-support.mjs",
            ),
          ).href
        );
        paired = await module.createPairedReaderAssertions({
          native: readerFixture,
          nativeRoot: fileURLToPath(new URL("../../", import.meta.url)),
          nativeRuntimeCommit: "019bec358a9816b5a6f8c09d3265120241472b90",
          rustTestBinary,
          reportPath,
        });
      }
      const activeRoot = tryBeginGatewayRootWorkAdmission("reader-fixture:accepted-work");
      assert(activeRoot);
      const expiresAtMs = Date.now() + 60_000;
      let delivered = false;
      let pairedRetirement: Promise<unknown> | undefined;
      let prepared: ResponseFrame;
      try {
        if (paired) {
          const draining = createDeferredCore();
          const detach = onGatewaySuspendAdmissionChange((phase) => {
            if (phase === "draining") {
              draining.resolve();
            }
          });
          try {
            pairedRetirement = paired.start(expiresAtMs).then((result) => {
              delivered = true;
              return result.source.native;
            });
            await Promise.race([
              draining.promise,
              pairedRetirement.then(() => {
                throw new Error("Release consumer completed before the actual native drain");
              }),
            ]);
          } finally {
            detach();
          }
          const held = currentSuspension();
          assert(held?.kind === "held");
          expect(held.requestId).toBe("reader-replacement");
          prepared = await client.request("gateway.suspend.status", {
            suspensionId: held.suspensionId,
            includeLifecycle: true,
          });
          expect(prepared.payload).toMatchObject({
            ownerId: "reader-replacement",
            phase: "draining",
          });
        } else {
          prepared = await client.request("gateway.suspend.prepare", {
            requestId: "reader-replacement",
            drain: true,
            terminalPolicy: "terminate",
          });
        }
        expect(prepared).toMatchObject({ ok: true, payload: { status: "draining" } });
        const drainingClient = await open();
        expect(drainingClient.hello.ok, JSON.stringify(drainingClient.hello)).toBe(true);
        const history = await drainingClient.request("chat.history", { sessionKey });
        expect(history.ok, JSON.stringify(history)).toBe(true);
        expect(JSON.stringify(history.payload)).toContain("Retain this accepted turn");
        expect(
          await drainingClient.request("sessions.describe", { key: sessionKey }),
        ).toMatchObject({
          ok: true,
          payload: { session: { label: "Reader mutation baseline" } },
        });
        expect(
          await drainingClient.request("sessions.patch", { ...labelTarget, label: "Drain denied" }),
        ).toMatchObject({
          ok: false,
          error: { code: "UNAVAILABLE", details: { phase: "draining" } },
        });
        const drainingSelf = await drainingClient.request("users.self", {});
        expect(drainingSelf.ok).toBe(true);
        expect(drainingSelf.payload).toEqual(self.payload);
        expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
      } finally {
        activeRoot.release();
      }
      const held = currentSuspension();
      assert(held?.kind === "held");
      expect(held.requestId).toBe("reader-replacement");
      const payload = { suspensionId: held.suspensionId };
      expect(
        await client.request("gateway.suspend.status", { suspensionId: payload.suspensionId }),
      ).toMatchObject({
        ok: true,
        payload: { status: "ready" },
      });
      const preparedDescription = await client.request("sessions.describe", { key: sessionKey });
      expect(preparedDescription.ok, JSON.stringify(preparedDescription)).toBe(true);
      const privateControl = await open(true, privatePassword);
      expect(privateControl.hello.ok, JSON.stringify(privateControl.hello)).toBe(true);
      const controlStatus = await privateControl.request("gateway.suspend.status", {
        suspensionId: payload.suspensionId,
      });
      expect(controlStatus.ok, JSON.stringify(controlStatus)).toBe(true);
      const controlClient = [...fixture.kernels.get(port)!.clients].find(
        (connected) => connected.connect.client.id === "cli",
      );
      expect(controlClient).toMatchObject({
        internal: { authenticatedOperator: true, operatorRoleActor: { kind: "system" } },
      });
      expect(controlClient?.authenticatedUserProfile).toBeUndefined();
      expect(controlClient?.authenticatedUserId).toBeUndefined();
      for (const path of [
        "/",
        "/readyz",
        "/startupz",
        "/sessions/agent%3Amain%3Areader-fixture/history",
      ]) {
        expect((await fetch(`http://127.0.0.1:${port}${path}`, { headers })).status).toBe(200);
      }
      const request = {
        suspensionId: payload.suspensionId,
        target: { pid: process.pid, processInstanceId: getGatewayProcessInstanceId() },
        expiresAtMs,
      };
      const wrongTarget = await client.request("gateway.suspend.reader", {
        ...request,
        target: { ...request.target, processInstanceId: "wrong-instance" },
      });
      expect(wrongTarget.ok).toBe(false);
      const wrongLease = await client.request("gateway.suspend.reader", {
        ...request,
        suspensionId: "wrong-lease",
      });
      expect(wrongLease.ok).toBe(false);
      const nativeClient = [...fixture.kernels.get(port)!.clients][0]!;
      const before = {
        profile: nativeClient.authenticatedUserProfile?.profileId,
        canonical: nativeClient.preparedSessionProfile?.profileId,
        user: nativeClient.authenticatedUserId,
        role: nativeClient.connect.role,
        scopes: [...(nativeClient.connect.scopes ?? [])],
      };
      const retirement =
        pairedRetirement ??
        client.request("gateway.suspend.reader", request).then((response) => {
          expect(response.ok, JSON.stringify(response)).toBe(true);
          delivered = true;
          return response.payload;
        });
      await Promise.race([
        enteredWriterJoin.promise,
        retirement.then((receipt) => {
          throw new Error(
            `Reader returned before host join: ${JSON.stringify({ receipt, before, after: { profile: nativeClient.authenticatedUserProfile?.profileId, canonical: nativeClient.preparedSessionProfile?.profileId, user: nativeClient.authenticatedUserId, role: nativeClient.connect.role, scopes: nativeClient.connect.scopes, invalidated: nativeClient.invalidated } })}`,
          );
        }),
      ]);
      expect(delivered).toBe(false);
      expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
      for (const path of ["/healthz", "/startupz", "/readyz"]) {
        for (const method of ["GET", "HEAD"]) {
          const probe = await fetch(`http://127.0.0.1:${port}${path}`, {
            method,
            headers: { connection: "close" },
          });
          expect(probe.status, `fresh loopback ${method} ${path} while writer joins`).toBe(200);
          await probe.text();
        }
      }
      const joining = await open();
      expect(joining.hello.ok, JSON.stringify(joining.hello)).toBe(true);
      expect(
        (await joining.request("chat.history", { sessionKey: "agent:main:reader-fixture" })).ok,
      ).toBe(true);
      expect((await joining.request("sessions.describe", { key: sessionKey })).ok).toBe(true);
      const joiningSelf = await joining.request("users.self", {});
      expect(joiningSelf.ok).toBe(true);
      expect(joiningSelf.payload).toEqual(self.payload);
      for (const path of [
        "/",
        "/readyz",
        "/startupz",
        "/sessions/agent%3Amain%3Areader-fixture/history",
      ]) {
        expect((await fetch(`http://127.0.0.1:${port}${path}`, { headers })).status).toBe(200);
      }
      expect(
        (await fetch(`http://127.0.0.1:${port}/tools/invoke`, { method: "POST", headers })).status,
      ).toBe(503);
      expect(delivered).toBe(false);
      const deniedUi = await fetch(`http://127.0.0.1:${port}/`, { headers: { origin } });
      expect(deniedUi.status).toBe(401);
      await paired?.assertJoining();
      finishWriterJoin.resolve();
      const receipt = await retirement;
      writerSettled = true;
      expect(receipt).toMatchObject({
        version: 1,
        status: "reader-ready",
        ...request.target,
        expiresAtMs: request.expiresAtMs,
      });
      const frozen = await fs.readFile(resolveOpenClawStateSqlitePath());
      const readWal = (path: string) =>
        fs.readFile(`${path}-wal`).catch((error: unknown) => {
          if (isMissingPathError(error)) {
            return null;
          }
          throw error;
        });
      const frozenWal = await readWal(resolveOpenClawStateSqlitePath());
      const readAgentBytes = async () => {
        const path = resolveOpenClawAgentSqlitePath({ agentId: "main" });
        return {
          database: await fs.readFile(path),
          wal: await readWal(path),
        };
      };
      const frozenAgent = await readAgentBytes();
      const frozenConfig = await fs.readFile(fixture.state.configPath);
      await paired?.assertFrozen();
      // The paired oracle covers broker reads; native reads retain the exact post-pair WAL.
      const nativeWal = paired ? await readWal(resolveOpenClawStateSqlitePath()) : frozenWal;
      if (paired) {
        expect(frozenWal === null && nativeWal?.length === 0 ? null : nativeWal).toEqual(frozenWal);
      }
      const frozenControl = await open(true, privatePassword);
      expect(frozenControl.hello.ok, JSON.stringify(frozenControl.hello)).toBe(true);
      expect((await frozenControl.request("users.self", {})).ok).toBe(false);
      const frozenStatus = await frozenControl.request("gateway.suspend.status", {
        suspensionId: payload.suspensionId,
      });
      expect(frozenStatus.ok, JSON.stringify(frozenStatus)).toBe(true);
      const sdkStatus = await callGatewayFromCli(
        "gateway.suspend.status",
        { url: "ws://127.0.0.1:18789", password: privatePassword, timeout: "10000", json: true },
        { suspensionId: payload.suspensionId },
        {
          progress: false,
          deviceIdentity: null,
          sharedStateMode: "read-only",
          scopes: ["operator.admin"],
        },
      );
      expect(sdkStatus).toMatchObject({ status: "ready" });
      expect(sdkStatus).toEqual(frozenStatus.payload);
      expect((await frozenControl.request("config.patch", { raw: "{}" })).ok).toBe(false);
      expect(
        (
          await frozenControl.request("users.prefs.set", {
            entries: { "git.coauthor.enabled": true },
          })
        ).ok,
      ).toBe(false);
      expect((await open(true, "incorrect-private-control")).hello.ok).toBe(false);
      const missing = await open(true, undefined, missingPrincipal);
      expect(missing.hello.ok).toBe(false);
      expect(missing.hello.error?.details).toMatchObject({
        code: "AUTHENTICATED_PROFILE_UNAVAILABLE",
        method: "connect",
      });
      const guest = await open(true, undefined, guestPrincipal);
      expect(guest.hello.ok, JSON.stringify(guest.hello)).toBe(true);
      expect((await guest.request("chat.history", { sessionKey })).ok).toBe(false);
      expect((await guest.request("sessions.describe", { key: sessionKey })).ok).toBe(false);
      const reconnected = await open();
      expect(reconnected.hello.ok, JSON.stringify(reconnected.hello)).toBe(true);
      for (const reader of [client, reconnected]) {
        const frozenSelf = await reader.request("users.self", {});
        expect(frozenSelf.ok).toBe(true);
        expect(frozenSelf.payload).toEqual(self.payload);
      }
      const originalClient = { ...nativeClient, pairedClientId: nativeClient.pairedClientId };
      const changedBindings: Partial<typeof nativeClient>[] = [
        { authenticatedUserProfile: undefined },
        { authenticatedUserId: guestPrincipal },
        { authenticatedFactoryGitHubAccountId: 103 },
        { connId: "replaced-connection" },
        { pairedClientId: "replaced-device-client" },
        { connect: { ...nativeClient.connect, role: "node" } },
        { connect: { ...nativeClient.connect, scopes: [] } },
        {
          connect: {
            ...nativeClient.connect,
            client: { ...nativeClient.connect.client, id: "cli" },
          },
        },
      ];
      const readSelf = profileReads.readCanonicalUserProfileListItem;
      for (const changed of changedBindings) {
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const read = vi
          .spyOn(profileReads, "readCanonicalUserProfileListItem")
          .mockImplementationOnce(async (...args) => {
            const result = await readSelf(...args);
            entered.resolve();
            await release.promise;
            return result;
          });
        const pendingSelf = client.request("users.self", {});
        try {
          await entered.promise;
          Object.assign(nativeClient, changed);
          release.resolve();
          expect((await pendingSelf).ok, JSON.stringify(changed)).toBe(false);
        } finally {
          release.resolve();
          await pendingSelf;
          Object.assign(nativeClient, originalClient);
          read.mockRestore();
        }
      }
      const deniedLabelPatch = await reconnected.request("sessions.patch", {
        ...labelTarget,
        label: "Reader mutation must be denied",
      });
      expect(deniedLabelPatch).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "sessions.patch unavailable on the retired Gateway writer",
        },
      });
      const retainedLabel = await reconnected.request("sessions.describe", { key: sessionKey });
      expect(retainedLabel).toMatchObject({
        ok: true,
        payload: { session: { label: "Reader mutation baseline" } },
      });
      expect(await resolveColdRoute(reconnected)).toMatchObject({
        kind: "session",
        sessionKey: shortSessionKey,
        agentId: "main",
      });
      const guestResolution = await guest.request("sessions.resolve", {
        shortId: "12345678",
        agentId: "main",
        allowMissing: true,
      });
      expect(guestResolution.ok).toBe(false);
      expect(guestResolution.error?.code).toBe("FORBIDDEN");
      const ambiguous = await reconnected.request("sessions.resolve", {
        shortId: "12345678",
        agentId: "main",
        allowMissing: true,
      });
      expect(ambiguous.ok).toBe(true);
      expect(ambiguous.payload).toMatchObject({
        ok: false,
        candidates: expect.arrayContaining([
          expect.objectContaining({ key: shortSessionKey }),
          expect.objectContaining({ key: ambiguousKey }),
        ]),
      });
      const coldHistory = await reconnected.request("chat.history", {
        sessionKey: shortSessionKey,
      });
      expect(coldHistory.ok).toBe(true);
      expect(JSON.stringify(coldHistory.payload)).toContain("Accepted cold-route history");
      expect(
        (
          await reconnected.request("sessions.resolve", {
            shortId: "ffffffff",
            agentId: "main",
            allowMissing: true,
          })
        ).payload,
      ).toEqual({ ok: false });
      const retained = await reconnected.request("chat.history", { sessionKey });
      expect(retained.ok, JSON.stringify(retained)).toBe(true);
      expect(JSON.stringify(retained.payload)).toContain("Retain this accepted turn");
      expect((await reconnected.request("sessions.list", {})).ok).toBe(true);
      expect((await reconnected.request("sessions.describe", { key: sessionKey })).ok).toBe(true);
      const avatarUrl = `http://127.0.0.1:${port}/api/users/${profile.id}/avatar`;
      const image = await fetch(avatarUrl, { headers });
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await image.arrayBuffer())).toEqual(avatarBytes);
      const head = await fetch(avatarUrl, { method: "HEAD", headers });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(
        (
          await fetch(avatarUrl, {
            headers: { ...headers, "if-none-match": image.headers.get("etag")! },
          })
        ).status,
      ).toBe(304);
      expect((await fetch(avatarUrl, { headers: { origin } })).status).toBe(401);
      const guestAvatar = await fetch(avatarUrl, {
        headers: { ...headers, "x-factory-principal": guestPrincipal },
      });
      expect(guestAvatar.status).toBe(200);
      expect(Buffer.from(await guestAvatar.arrayBuffer())).toEqual(avatarBytes);
      expect(
        (
          await fetch(avatarUrl, {
            headers: { ...headers, "x-factory-principal": noReadPrincipal },
          })
        ).status,
      ).toBe(403);
      expect(
        (await fetch(`http://127.0.0.1:${port}/api/users/${blank.id}/avatar`, { headers })).status,
      ).toBe(404);
      expect(
        (
          await reconnected.request("chat.send", {
            sessionKey: "agent:main:reader-fixture",
            message: "must not execute",
            idempotencyKey: "reader-denied",
          })
        ).ok,
      ).toBe(false);
      expect((await open(false)).hello.ok).toBe(false);
      for (const path of ["/healthz", "/readyz", "/startupz"]) {
        expect((await fetch(`http://127.0.0.1:${port}${path}`, { headers })).status).toBe(200);
        for (const method of ["GET", "HEAD"]) {
          const probe = await fetch(`http://127.0.0.1:${port}${path}`, {
            method,
            headers: { connection: "close" },
          });
          expect(probe.status, `fresh loopback ${method} ${path} on bounded reader`).toBe(200);
          await probe.text();
        }
      }
      expect(
        (await fetch(`http://127.0.0.1:${port}/tools/invoke`, { method: "POST", headers })).status,
      ).toBe(503);
      expect(await fs.readFile(resolveOpenClawStateSqlitePath())).toEqual(frozen);
      expect(await readWal(resolveOpenClawStateSqlitePath())).toEqual(nativeWal);
      expect(await readAgentBytes()).toEqual(frozenAgent);
      expect(await fs.readFile(fixture.state.configPath)).toEqual(frozenConfig);
      vi.useFakeTimers({ toFake: ["Date", "performance"] });
      vi.setSystemTime(request.expiresAtMs);
      await paired?.assertExpired();
      expect((await reconnected.request("users.self", {})).ok).toBe(false);
      expect((await fetch(avatarUrl, { headers })).status).toBe(503);
      await expect(resolveColdRoute(reconnected)).rejects.toThrow();
      expect(
        (await reconnected.request("chat.history", { sessionKey: "agent:main:reader-fixture" })).ok,
      ).toBe(false);
      expect((await reconnected.request("sessions.describe", { key: sessionKey })).ok).toBe(false);
      expect((await fetch(`http://127.0.0.1:${port}/startupz`, { headers })).status).toBe(503);
      expect((await fetch(`http://127.0.0.1:${port}/readyz`, { headers })).status).toBe(503);
      for (const path of ["/startupz", "/readyz"]) {
        expect(
          (
            await fetch(`http://127.0.0.1:${port}${path}`, {
              headers: { connection: "close" },
            })
          ).status,
        ).toBe(503);
      }
      vi.setSystemTime(request.expiresAtMs - 30_000);
      expect((await reconnected.request("users.self", {})).ok).toBe(false);
      expect(
        (await reconnected.request("chat.history", { sessionKey: "agent:main:reader-fixture" })).ok,
      ).toBe(false);
      expect(() => resetGatewayWorkAdmission()).toThrow("irreversible reader");
      vi.useRealTimers();
    });
  } finally {
    vi.useRealTimers();
    finishWriterJoin.resolve();
    try {
      await paired?.close();
    } finally {
      await readerFixture.cleanup();
    }
    if (writerSettled) {
      await expect(fetch(`http://127.0.0.1:${port}/startupz`, { headers })).rejects.toThrow();
    }
    expect(
      closeErrors.mock.calls.filter(([message]) =>
        message.includes("websocket close cleanup failed"),
      ),
    ).toEqual([]);
    closeErrors.mockRestore();
  }
});
