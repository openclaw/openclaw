import {
  ErrorCodes,
  errorShape,
  validateTranscriptsListParams,
  validateTranscriptsGetParams,
  validateTranscriptsSummarizeParams,
  validateTranscriptsExportParams,
  validateTranscriptsStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createTranscriptsStore } from "../../transcripts/capture-operations.js";
import { ensureTranscriptSummary } from "../../transcripts/capture-summary.js";
import { resolveSourceProvider } from "../../transcripts/capture.js";
import { resolveTranscriptsConfig } from "../../transcripts/config.js";
import {
  exportTranscriptLibrary,
  getTranscriptLibrary,
  listTranscriptLibrary,
} from "../../transcripts/library.js";
import { readTranscriptLibraryStatus } from "../../transcripts/status.js";
import { TranscriptLibraryError } from "../../transcripts/store-read.js";
import type { TranscriptsStore } from "../../transcripts/store.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import { isGatewayAdmin } from "../session-sharing.js";
import { formatForLog } from "../ws-log.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";
import { assertValidParams, type Validator } from "./validation.js";

function transcriptMethod<T>(
  method: string,
  validate: Validator<T>,
  read: (
    store: TranscriptsStore,
    params: T,
    cfg: OpenClawConfig,
    assertCurrent: () => void,
  ) => Promise<unknown>,
): GatewayRequestHandler {
  return async (options) => {
    const { params, context, client, respond } = options;
    if (!assertValidParams(params, validate, method, respond)) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    // Meeting rows have agent attribution but no person owner. Mirror global
    // aggregate visibility; an agent filter cannot make hidden archive data readable.
    if (!isGatewayAdmin(client) && operatorSessionCap(client, cfg) === "none") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          "The transcript archive includes sessions hidden by your operator role; ask a Gateway administrator for archive access.",
        ),
      );
      return;
    }
    try {
      const store = createTranscriptsStore({
        stateDir: resolveStateDir(),
        config: cfg,
        logger: console,
      });
      const authority = readGatewayRequestMutationAuthority(options);
      const assertCurrent = () => {
        authority.assertCurrent();
        if (
          !isGatewayAdmin(client) &&
          operatorSessionCap(client, context.getRuntimeConfig()) === "none"
        ) {
          throw new Error("Transcript archive access changed");
        }
      };
      respond(true, await read(store, params, cfg, assertCurrent));
    } catch (error) {
      if (!(error instanceof TranscriptLibraryError)) {
        context.logGateway.warn(`${method} failed: ${formatForLog(error)}`);
      }
      respond(
        false,
        undefined,
        error instanceof TranscriptLibraryError
          ? errorShape(ErrorCodes.INVALID_REQUEST, error.message, {
              details: {
                type: error.type,
                ...(error.maxBytes !== undefined ? { maxBytes: error.maxBytes } : {}),
              },
            })
          : errorShape(
              ErrorCodes.UNAVAILABLE,
              `${method === "transcripts.summarize" ? "The meeting summary could not be generated" : "The transcript archive could not be read"}. Check Gateway diagnostics and retry.`,
            ),
      );
    }
  };
}

export const transcriptsHandlers: GatewayRequestHandlers = {
  "transcripts.list": transcriptMethod(
    "transcripts.list",
    validateTranscriptsListParams,
    (store, params, cfg) => listTranscriptLibrary(store, params, providerNames(cfg)),
  ),
  "transcripts.get": transcriptMethod(
    "transcripts.get",
    validateTranscriptsGetParams,
    (store, params, cfg) => getTranscriptLibrary(store, params, providerNames(cfg)),
  ),
  "transcripts.summarize": transcriptMethod(
    "transcripts.summarize",
    validateTranscriptsSummarizeParams,
    async (store, params, cfg, assertCurrent) => {
      const { entry } = await store.readLibraryEntry(params);
      assertCurrent();
      if (!entry.hasSummary && entry.utteranceCount > 0) {
        await ensureTranscriptSummary({
          store,
          session: entry.session,
          config: resolveTranscriptsConfig(cfg.transcripts),
          cfg,
          allowAppends: entry.session.stoppedAt === undefined,
          assertCurrent,
        });
      }
      assertCurrent();
      const result = await getTranscriptLibrary(store, params, providerNames(cfg));
      assertCurrent();
      return result;
    },
  ),
  "transcripts.export": transcriptMethod(
    "transcripts.export",
    validateTranscriptsExportParams,
    exportTranscriptLibrary,
  ),
  "transcripts.status": transcriptMethod(
    "transcripts.status",
    validateTranscriptsStatusParams,
    (store, _params, cfg) => readTranscriptLibraryStatus(store, cfg),
  ),
};

function providerNames(config: OpenClawConfig) {
  const names = new Map<string, string | undefined>();
  return (providerId: string) => {
    if (!names.has(providerId)) {
      names.set(
        providerId,
        resolveSourceProvider(providerId, {
          config,
          stateDir: resolveStateDir(),
          logger: console,
        })?.name,
      );
    }
    return names.get(providerId);
  };
}
