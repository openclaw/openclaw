import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { jsonResult } from "../../agents/tools/common.js";
import type { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import { assertOutboundHandoffCurrent } from "../../infra/outbound/deliver-handoff.js";
import type { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { handleGatewayRequest } from "../server-methods.js";
import {
  agentRuntimeClientForTests as agentRuntimeClient,
  directCliClientForTests as directCliClient,
  firstRespondCall,
} from "./send.test-helpers.js";
import {
  type createMessageMethodPluginFixtures,
  type createMessageMethodTestDriver,
  makeContext,
} from "./send.test-support.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

type UploadPolicyTestHarness = Pick<
  ReturnType<typeof createMessageMethodTestDriver>,
  "runSendWithClient" | "runMessageActionRequest"
> &
  Pick<ReturnType<typeof createMessageMethodPluginFixtures>, "registerMessageActionPlugin"> & {
    mocks: {
      deliverOutboundPayloads: Mock<typeof deliverOutboundPayloads>;
      dispatchChannelMessageAction: Mock<typeof dispatchChannelMessageAction>;
    };
    mockDeliverySuccess: (messageId: string) => void;
  };

// Register in the existing send suite so all shared setup and test ordering stay intact.
export function registerSendUploadPolicyTests({
  mocks,
  runSendWithClient,
  runMessageActionRequest,
  registerMessageActionPlugin,
  mockDeliverySuccess,
}: UploadPolicyTestHarness): void {
  describe.each(["send", "message.action"] as const)("%s client upload commit policy", (method) => {
    const tempDirs = useAutoCleanupTempDirTracker(afterEach);
    const bytes = "client upload commit fixture";

    function uploadFixture() {
      const stateDir = tempDirs.make("gateway-send-upload-policy-");
      const env = captureEnv(["OPENCLAW_STATE_DIR"]);
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      let enabled = true;
      const context = {
        ...makeContext(),
        // The admitted snapshot deliberately stays enabled after the committed policy changes.
        getRuntimeConfig: () => ({ gateway: { uploads: { enabled: true } } }),
        getCommittedRuntimeConfig: () => ({ gateway: { uploads: { enabled } } }),
      } as GatewayRequestContext;
      const plugin = registerMessageActionPlugin({
        id: "slack",
        registrySuffix: "client-upload-policy",
      });
      const invoke = async (
        options: {
          trusted?: boolean;
          mediaUrl?: string;
          viaRouter?: boolean;
          idempotencyKey?: string;
        } = {},
      ) => {
        const sessionKey = "agent:main:slack:channel:C1";
        const client = options.trusted
          ? agentRuntimeClient(sessionKey)
          : { connect: { ...directCliClient().connect, scopes: ["operator.write"] } };
        const content = options.mediaUrl
          ? { mediaUrl: options.mediaUrl }
          : {
              buffer: Buffer.from(bytes).toString("base64"),
              filename: "upload.txt",
              contentType: "text/plain",
            };
        const common = {
          channel: "slack",
          agentId: "main",
          ...(options.trusted ? { sessionKey } : {}),
          idempotencyKey: options.idempotencyKey ?? "client-upload-policy",
        };
        if (options.viaRouter) {
          const params =
            method === "send"
              ? { ...common, to: "channel:C1", ...content }
              : { ...common, action: "send", params: { to: "channel:C1", ...content } };
          const respond = vi.fn<RespondFn>();
          await handleGatewayRequest({
            req: { type: "req", id: "same-wire-id", method, params },
            respond,
            context,
            client: {
              connect: {
                minProtocol: 1,
                maxProtocol: 1,
                role: "operator",
                scopes: ["operator.admin"],
                client: { id: "cli", mode: "cli", platform: "test", version: "test" },
              },
            },
            isWebchatConnect: () => false,
          });
          return { respond };
        }
        return method === "send"
          ? runSendWithClient({ ...common, to: "channel:C1", ...content }, client, context)
          : runMessageActionRequest(
              { ...common, action: "send", params: { to: "channel:C1", ...content } },
              client,
              context,
            );
      };
      return {
        plugin,
        context,
        invoke,
        enable: () => {
          enabled = true;
        },
        outboundDir: path.join(stateDir, "media", "outbound"),
        disable: () => {
          enabled = false;
        },
        restore: () => env.restore(),
      };
    }

    it.each([false, true])(
      "replays accepted uploads through the router after disable (inflight: %s)",
      async (inflight) => {
        const fixture = uploadFixture();
        let defaultAccountId = "primary";
        fixture.plugin.config.listAccountIds = () => ["primary", "secondary"];
        fixture.plugin.config.defaultAccountId = () => defaultAccountId;
        fixture.plugin.config.resolveAccount = (_cfg, accountId) => ({ accountId, enabled: true });
        const entered = createDeferred();
        const release = createDeferred();
        const acceptedSend = vi.fn();
        const accepted = async (params: { assertDirectAdapterHandoff?: () => void }) => {
          assertOutboundHandoffCurrent(params.assertDirectAdapterHandoff);
          acceptedSend();
          entered.resolve();
          await release.promise;
        };
        if (method === "send") {
          mocks.deliverOutboundPayloads.mockImplementation(async (params) => {
            await accepted(params);
            return [{ channel: "slack", messageId: "accepted-upload" }];
          });
        } else {
          const actual = await vi.importActual<
            typeof import("../../channels/plugins/message-action-dispatch.js")
          >("../../channels/plugins/message-action-dispatch.js");
          mocks.dispatchChannelMessageAction.mockImplementation(
            actual.dispatchChannelMessageAction,
          );
          expectDefined(fixture.plugin.actions, "upload action adapter").handleAction = async (
            ctx,
          ) => {
            await accepted(ctx);
            return jsonResult({ ok: true, messageId: "accepted-upload" });
          };
        }
        const first = fixture.invoke({ viaRouter: true });
        let restoreReplay: (() => void) | undefined;
        try {
          await Promise.race([entered.promise, first]);
          expect(acceptedSend).toHaveBeenCalledTimes(1);
          if (!inflight) {
            release.resolve();
            expect(firstRespondCall((await first).respond)[0]).toBe(true);
          }
          const files = await fs.readdir(fixture.outboundDir);
          const replayReached = createDeferred();
          const readDedupe = fixture.context.dedupe.get.bind(fixture.context.dedupe);
          const observeReplay = vi
            .spyOn(fixture.context.dedupe, "get")
            .mockImplementation((key) => {
              const result = readDedupe(key);
              if (key.endsWith(":client-upload-policy")) {
                replayReached.resolve();
              }
              return result;
            });
          restoreReplay = () => observeReplay.mockRestore();
          fixture.disable();
          const retry = fixture.invoke({ viaRouter: true });
          await Promise.race([
            replayReached.promise,
            retry.then(({ respond }) => {
              expect(firstRespondCall(respond)[0]).toBe(true);
              expect(firstRespondCall(respond)[3]).toMatchObject({ cached: true });
            }),
          ]);
          release.resolve();
          const [{ respond: initial }, { respond: replay }] = await Promise.all([first, retry]);
          expect(firstRespondCall(replay).slice(0, 3)).toEqual(
            firstRespondCall(initial).slice(0, 3),
          );
          expect(firstRespondCall(replay)[3]).toMatchObject({ cached: true });
          restoreReplay();
          restoreReplay = undefined;
          const fresh = { viaRouter: true, idempotencyKey: "fresh-upload-key" };
          const denied = await fixture.invoke(fresh);
          expect(firstRespondCall(denied.respond)[2]).toMatchObject({
            code: ErrorCodes.FORBIDDEN,
            details: { code: "UPLOADS_DISABLED" },
          });
          expect(
            [...fixture.context.dedupe.keys()].some((key) => key.endsWith(":fresh-upload-key")),
          ).toBe(false);
          expect(await fs.readdir(fixture.outboundDir)).toEqual(files);
          expect(acceptedSend).toHaveBeenCalledTimes(1);
          defaultAccountId = "secondary";
          fixture.enable();
          expect(firstRespondCall((await fixture.invoke(fresh)).respond)[0]).toBe(true);
          expect(
            [...fixture.context.dedupe.keys()].filter((key) => key.endsWith(":fresh-upload-key")),
          ).toEqual([expect.stringContaining('["slack","secondary"]')]);
          expect(acceptedSend).toHaveBeenCalledTimes(2);
        } finally {
          restoreReplay?.();
          release.resolve();
          await first;
          fixture.restore();
        }
      },
    );

    it.each([
      { disable: false, trusted: false },
      { disable: true, trusted: false },
      { disable: true, trusted: true },
    ])(
      "checks policy after media directory preparation (disabled: $disable, trusted: $trusted)",
      async ({ disable, trusted }) => {
        const fixture = uploadFixture();
        const prepared = createDeferred();
        const release = createDeferred();
        let preparing = false;
        const originalMkdir = fs.mkdir;
        // This await belongs to saveMediaBuffer on both the original and repaired paths.
        // Native fs-safe publication need not call the JavaScript fs.open implementation.
        const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
          const result = await originalMkdir(...args);
          if (!preparing && args[0] === fixture.outboundDir) {
            preparing = true;
            prepared.resolve();
            await release.promise;
          }
          return result;
        });
        mockDeliverySuccess("upload-accepted");
        const request = fixture.invoke({ trusted });
        try {
          await Promise.race([prepared.promise, request]);
          expect(preparing).toBe(true);
          if (disable) {
            fixture.disable();
          }
          release.resolve();
          const { respond } = await request;
          const denied = disable && !trusted;
          expect(firstRespondCall(respond)[0]).toBe(!denied);
          if (denied) {
            expect(firstRespondCall(respond)[2]).toMatchObject({
              code: ErrorCodes.FORBIDDEN,
              details: { code: "UPLOADS_DISABLED" },
            });
            expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
            expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
            expect(await fs.readdir(fixture.outboundDir)).toEqual([]);
          } else {
            const files = await fs.readdir(fixture.outboundDir);
            expect(files).toHaveLength(1);
            await expect(
              fs.readFile(path.join(fixture.outboundDir, files[0]!), "utf8"),
            ).resolves.toBe(bytes);
          }
        } finally {
          release.resolve();
          try {
            await request;
          } finally {
            mkdirSpy.mockRestore();
            fixture.restore();
          }
        }
      },
    );

    it.each([
      { boundary: "dispatch", trusted: false, accepted: false, reference: false },
      { boundary: "handoff", trusted: false, accepted: false, reference: false },
      { boundary: "handoff", trusted: true, accepted: false, reference: false },
      { boundary: "handoff", trusted: false, accepted: true, reference: false },
      { boundary: "handoff", trusted: false, accepted: false, reference: true },
    ] as const)(
      "retains ingress classification at $boundary (trusted: $trusted, accepted: $accepted, reference: $reference)",
      async ({ boundary, trusted, accepted, reference }) => {
        const fixture = uploadFixture();
        const entered = createDeferred();
        const release = createDeferred();
        const platformSend = vi.fn();
        let prepared = false;
        const send = async (params: {
          onPlatformSendDispatch?: () => Promise<void>;
          assertDirectAdapterHandoff?: () => void;
        }) => {
          if (boundary === "handoff") {
            await params.onPlatformSendDispatch?.();
          }
          if (accepted) {
            assertOutboundHandoffCurrent(params.assertDirectAdapterHandoff);
            platformSend();
          }
          prepared = true;
          entered.resolve();
          await release.promise;
          if (!accepted) {
            if (boundary === "dispatch") {
              await params.onPlatformSendDispatch?.();
            }
            assertOutboundHandoffCurrent(params.assertDirectAdapterHandoff);
            platformSend();
          }
        };
        if (method === "message.action") {
          const { dispatchChannelMessageAction } = await vi.importActual<
            typeof import("../../channels/plugins/message-action-dispatch.js")
          >("../../channels/plugins/message-action-dispatch.js");
          mocks.dispatchChannelMessageAction.mockImplementationOnce(dispatchChannelMessageAction);
          const actions = expectDefined(fixture.plugin.actions, "upload action adapter");
          actions.handleAction = async (ctx) => {
            expect(ctx.params).not.toHaveProperty("buffer");
            await send(ctx);
            return jsonResult({ ok: true, messageId: "upload-accepted" });
          };
        } else {
          mocks.deliverOutboundPayloads.mockImplementationOnce(async (params) => {
            await send(params);
            return [{ channel: "slack", messageId: "upload-accepted" }];
          });
        }
        const request = fixture.invoke({
          trusted,
          ...(reference ? { mediaUrl: "https://example.com/already-hosted.png" } : {}),
        });
        try {
          await Promise.race([entered.promise, request]);
          expect(prepared).toBe(true);
          if (!reference) {
            const files = await fs.readdir(fixture.outboundDir);
            expect(files).toHaveLength(1);
            await expect(
              fs.readFile(path.join(fixture.outboundDir, files[0]!), "utf8"),
            ).resolves.toBe(bytes);
          }
          fixture.disable();
          release.resolve();
          const { respond } = await request;
          const allowed = trusted || accepted || reference;
          expect(firstRespondCall(respond)[0]).toBe(allowed);
          expect(platformSend).toHaveBeenCalledTimes(allowed ? 1 : 0);
          if (!allowed) {
            expect(firstRespondCall(respond)[2]).toMatchObject({
              code: ErrorCodes.FORBIDDEN,
              details: { code: "UPLOADS_DISABLED" },
            });
          }
        } finally {
          release.resolve();
          try {
            await request;
          } finally {
            fixture.restore();
          }
        }
      },
    );
  });
}
