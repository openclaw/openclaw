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
  type MessageMethodDriver,
  type MessageMethodPlugins,
  makeContext,
} from "./send.test-support.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

type UploadPolicyTestHarness = Pick<
  MessageMethodDriver,
  "runSendWithClient" | "runMessageActionRequest"
> &
  Pick<MessageMethodPlugins, "registerMessageActionPlugin"> & {
    mocks: {
      deliverOutboundPayloads: Mock<typeof deliverOutboundPayloads>;
      dispatchChannelMessageAction: Mock<typeof dispatchChannelMessageAction>;
    };
    mockDeliverySuccess: (messageId: string) => void;
  };

type AdapterHandoff = {
  onPlatformSendDispatch?: () => Promise<void>;
  assertDirectAdapterHandoff?: () => void;
  params?: Record<string, unknown>;
};

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
    let env: ReturnType<typeof captureEnv> | undefined;
    afterEach(() => env?.restore());

    function expectUploadsDisabled(response: ReturnType<typeof firstRespondCall>) {
      expect(response[2]).toMatchObject({
        code: ErrorCodes.FORBIDDEN,
        details: { code: "UPLOADS_DISABLED" },
      });
    }

    function uploadFixture() {
      const stateDir = tempDirs.make("gateway-send-upload-policy-");
      env = captureEnv(["OPENCLAW_STATE_DIR"]);
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      let enabled = true;
      const context = {
        ...makeContext(),
        // The admitted snapshot deliberately stays enabled after the committed policy changes.
        getRuntimeConfig: () => ({ gateway: { uploads: { enabled: true } } }),
        getCommittedRuntimeConfig: () => ({ gateway: { uploads: { enabled } } }),
      } as GatewayRequestContext;
      const plugin = registerMessageActionPlugin({ id: "slack" });
      const invoke = async (
        options: {
          trusted?: boolean;
          mediaUrl?: string;
          viaRouter?: boolean;
          idempotencyKey?: string;
        } = {},
      ) => {
        const sessionKey = "agent:main:slack:channel:C1";
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
          idempotencyKey: options.idempotencyKey ?? "upload",
        };
        const params =
          method === "send"
            ? { ...common, to: "channel:C1", ...content }
            : { ...common, action: "send", params: { to: "channel:C1", ...content } };
        if (options.viaRouter) {
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
          return firstRespondCall(respond);
        }
        const client = options.trusted
          ? agentRuntimeClient(sessionKey)
          : { connect: { ...directCliClient().connect, scopes: ["operator.write"] } };
        const { respond } = await (method === "send"
          ? runSendWithClient(params, client, context)
          : runMessageActionRequest(params, client, context));
        return firstRespondCall(respond);
      };
      return {
        plugin,
        context,
        invoke,
        dedupeKeys: (suffix: string) =>
          [...context.dedupe.keys()].filter((key) => key.endsWith(`:${suffix}`)),
        mockAdapter: async (send: (params: AdapterHandoff) => Promise<void>, once = true) => {
          const install = once ? "mockImplementationOnce" : "mockImplementation";
          if (method === "send") {
            mocks.deliverOutboundPayloads[install](async (params) => {
              await send(params);
              return [{ channel: "slack", messageId: "upload-accepted" }];
            });
          } else {
            const { dispatchChannelMessageAction } = await vi.importActual<
              typeof import("../../channels/plugins/message-action-dispatch.js")
            >("../../channels/plugins/message-action-dispatch.js");
            mocks.dispatchChannelMessageAction[install](dispatchChannelMessageAction);
            expectDefined(plugin.actions, "upload action adapter").handleAction = async (ctx) => {
              await send(ctx);
              return jsonResult({ ok: true, messageId: "upload-accepted" });
            };
          }
        },
        outboundDir: path.join(stateDir, "media", "outbound"),
        setEnabled: (value: boolean) => {
          enabled = value;
        },
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
        await fixture.mockAdapter(accepted, false);
        const first = fixture.invoke({ viaRouter: true });
        try {
          await Promise.race([entered.promise, first]);
          expect(acceptedSend).toHaveBeenCalledTimes(1);
          if (!inflight) {
            release.resolve();
            expect((await first)[0]).toBe(true);
          }
          const files = await fs.readdir(fixture.outboundDir);
          const replayReached = createDeferred();
          const readDedupe = fixture.context.dedupe.get.bind(fixture.context.dedupe);
          using _ = vi.spyOn(fixture.context.dedupe, "get").mockImplementation((key) => {
            if (key.endsWith(":upload")) {
              replayReached.resolve();
            }
            return readDedupe(key);
          });
          fixture.setEnabled(false);
          const retry = fixture.invoke({ viaRouter: true });
          await Promise.race([replayReached.promise, retry]);
          release.resolve();
          const [initial, replay] = await Promise.all([first, retry]);
          expect(initial[0]).toBe(true);
          expect(replay.slice(0, 3)).toEqual(initial.slice(0, 3));
          expect(replay[3]).toMatchObject({ cached: true });
          const fresh = { viaRouter: true, idempotencyKey: "fresh" };
          expectUploadsDisabled(await fixture.invoke(fresh));
          expect(fixture.dedupeKeys("fresh")).toEqual([]);
          expect(await fs.readdir(fixture.outboundDir)).toEqual(files);
          expect(acceptedSend).toHaveBeenCalledTimes(1);
          defaultAccountId = "secondary";
          fixture.setEnabled(true);
          expect((await fixture.invoke(fresh))[0]).toBe(true);
          expect(fixture.dedupeKeys("fresh")).toEqual([
            expect.stringContaining('["slack","secondary"]'),
          ]);
          expect(acceptedSend).toHaveBeenCalledTimes(2);
        } finally {
          release.resolve();
          await first;
        }
      },
    );

    it.each(["directory", "dispatch", "handoff", "trusted runtime", "hosted reference"] as const)(
      "retains ingress classification at %s",
      async (stage) => {
        const trusted = stage === "trusted runtime",
          reference = stage === "hosted reference";
        const fixture = uploadFixture();
        const entered = createDeferred();
        const release = createDeferred();
        const platformSend = vi.fn();
        let prepared = false;
        const pause = async () => {
          prepared = true;
          entered.resolve();
          await release.promise;
        };
        const originalMkdir = fs.mkdir;
        // saveMediaBuffer yields here even when native fs-safe publication bypasses fs.open.
        using _ =
          stage === "directory"
            ? vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
                const result = await originalMkdir(...args);
                if (!prepared && args[0] === fixture.outboundDir) {
                  await pause();
                }
                return result;
              })
            : undefined;
        if (stage === "directory") {
          mockDeliverySuccess("upload-accepted");
        } else {
          await fixture.mockAdapter(async (params) => {
            if (method === "message.action") {
              expect(params.params).not.toHaveProperty("buffer");
            }
            if (stage !== "dispatch") {
              await params.onPlatformSendDispatch?.();
            }
            await pause();
            if (stage === "dispatch") {
              await params.onPlatformSendDispatch?.();
            } else {
              assertOutboundHandoffCurrent(params.assertDirectAdapterHandoff);
            }
            platformSend();
          });
        }
        const request = fixture.invoke({
          trusted,
          ...(reference ? { mediaUrl: "https://example.com/already-hosted.png" } : {}),
        });
        try {
          await Promise.race([entered.promise, request]);
          expect(prepared).toBe(true);
          if (stage !== "directory" && !reference) {
            const files = await fs.readdir(fixture.outboundDir);
            expect(files).toHaveLength(1);
            await expect(
              fs.readFile(path.join(fixture.outboundDir, files[0]!), "utf8"),
            ).resolves.toBe(bytes);
          }
          fixture.setEnabled(false);
          release.resolve();
          const response = await request;
          const allowed = trusted || reference;
          expect(response[0]).toBe(allowed);
          expect(platformSend).toHaveBeenCalledTimes(allowed ? 1 : 0);
          if (!allowed) {
            expectUploadsDisabled(response);
          }
          if (stage === "directory") {
            expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
            expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
            expect(await fs.readdir(fixture.outboundDir)).toEqual([]);
          }
        } finally {
          release.resolve();
          await request;
        }
      },
    );
  });
}
