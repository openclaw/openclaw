import { validateCronAddParams } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  CronJobConfigRevisionConflictError,
  resolveCronJobConfigRevision,
} from "../cron/config-revision.js";
import { assertValidCronCreateDelivery } from "../cron/delivery-channel-validation.js";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import type { CronJobScratchWriteResult } from "../cron/scratch-contract.js";
import type { CronServiceContract } from "../cron/service-contract.js";
import type { CronAddOptions } from "../cron/service/job-options.types.js";
import type { CronJobCreate } from "../cron/types.js";
import type { TemplateCronGateway } from "./cron.js";

type TemplateCronCreatorCapture = CronAddOptions & {
  assertInferenceSelectionCurrent?: () => void;
  assertOperatorSourceCurrent?: () => void;
  disposeOperatorSource?: () => void;
  disposeInferenceAuthorization?: () => void;
};

/** Both transports use the ordinary scheduler owner, with the same declaration and commit guards. */
export function createTemplateCronGateway(
  cron: Pick<
    CronServiceContract,
    "add" | "list" | "readJob" | "updateWithPrecondition" | "remove" | "getDefaultAgentId"
  > & {
    writeScratch(
      id: string,
      params: { content: string | null; expectedRevision?: number; commitGuard?: () => void },
    ): Promise<CronJobScratchWriteResult>;
  },
  getConfig: () => OpenClawConfig,
  assertCurrent: () => void,
  captureCreator?: (job: CronJobCreate, config: OpenClawConfig) => Promise<TemplateCronCreatorCapture>,
) {
  return {
    add: async (input, options) => {
      let creator: TemplateCronCreatorCapture | undefined;
      const guard = () => {
        assertCurrent();
        options?.commitGuard?.();
        creator?.assertInferenceSelectionCurrent?.();
        creator?.assertOperatorSourceCurrent?.();
      };
      guard();
      const normalized = normalizeCronJobCreate(input);
      if (!normalized || !validateCronAddParams(normalized)) {
        throw new Error("Template schedule declaration is invalid.");
      }
      const config = getConfig();
      try {
        creator = await captureCreator?.(normalized, config);
        await assertValidCronCreateDelivery(
          config,
          { ...normalized, createdActor: creator?.createdActor },
          cron.getDefaultAgentId(),
        );
        guard();
        const actor = creator?.createdActor;
        options?.captureOwnerProfileId?.(
          actor?.type === "human" && actor.source === "profile" ? actor.id : undefined,
        );
        return await cron.add(normalized, {
          ...creator,
          commitGuard: guard,
          matchesExisting: (job) => {
            if (job.declarationKey === normalized.declarationKey) {
              throw new Error("Template schedule declaration appeared after the list check.");
            }
            return false;
          },
        });
      } finally {
        creator?.disposeOperatorSource?.();
        creator?.disposeInferenceAuthorization?.();
      }
    },
    list: async (agentId) => ({
      jobs: (await cron.list({ includeDisabled: true })).filter((job) => job.agentId === agentId),
    }),
    get: async (id) => {
      assertCurrent();
      const job = await cron.readJob(id);
      return job ? { ...job, configRevision: resolveCronJobConfigRevision(job) } : undefined;
    },
    writeScratch: async (id, content, commitGuard) => {
      const result = await cron.writeScratch(id, {
        content,
        expectedRevision: 0,
        commitGuard: () => {
          assertCurrent();
          commitGuard();
        },
      });
      if (!result.ok) {
        throw new Error("Template automation scratch changed before import.");
      }
    },
    enable: async (id, expectedConfigRevision, commitGuard) => {
      await cron.updateWithPrecondition(
        id,
        { enabled: true },
        (job) => {
          const actual = resolveCronJobConfigRevision(job);
          if (actual !== expectedConfigRevision) {
            throw new CronJobConfigRevisionConflictError(expectedConfigRevision, actual);
          }
        },
        {
          commitGuard: () => {
            assertCurrent();
            commitGuard();
          },
        },
      );
    },
    remove: async (id, options) => {
      const guard = () => {
        assertCurrent();
        options.commitGuard?.();
      };
      guard();
      return await cron.remove(id, {
        commitGuard: guard,
        expectedConfigRevision: options.expectedConfigRevision,
      });
    },
  } satisfies TemplateCronGateway;
}
