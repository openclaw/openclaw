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
import type { TemplateCronGateway } from "./cron.js";

/** Both transports use the ordinary scheduler owner, with the same declaration and commit guards. */
export function createTemplateCronGateway(
  cron: Pick<
    CronServiceContract,
    "add" | "list" | "readJob" | "updateWithPrecondition" | "remove"
  > & {
    writeScratch(
      id: string,
      params: { content: string | null; expectedRevision?: number; commitGuard?: () => void },
    ): Promise<CronJobScratchWriteResult>;
  },
  getConfig: () => OpenClawConfig,
  assertCurrent: () => void,
) {
  return {
    add: async (input, options) => {
      const guard = () => {
        assertCurrent();
        options?.commitGuard?.();
      };
      guard();
      const normalized = normalizeCronJobCreate(input);
      if (!normalized || !validateCronAddParams(normalized)) {
        throw new Error("Template schedule declaration is invalid.");
      }
      await assertValidCronCreateDelivery(getConfig(), normalized);
      guard();
      return await cron.add(normalized, {
        commitGuard: guard,
        matchesExisting: (job) => {
          if (job.declarationKey === normalized.declarationKey) {
            throw new Error("Template schedule declaration appeared after the list check.");
          }
          return false;
        },
      });
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
