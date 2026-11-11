import type { SandboxConfig } from "../sandbox/types.js";
import type { WorktreeTemplateRecord } from "./template-registry.js";

/** Recipe facts survive a request; its authority and cancellation never do. */
export type WorktreeTemplateRecipe = { template: WorktreeTemplateRecord } & (
  | { kind: "managed"; sourceOnly: boolean }
  | { kind: "sandbox"; sandbox: SandboxConfig; temporaryRoot: string; buildCacheInputs?: string[] }
);

export type WorktreeTemplateSelection = Pick<
  WorktreeTemplateRecord,
  "cacheKey" | "contentKey" | "backend"
>;

export type WorktreeTemplateActivity =
  | { type: "used"; recipe: WorktreeTemplateRecipe }
  | { type: "base"; commonDir: string; commit: string }
  | {
      type: "preparation";
      selection?: WorktreeTemplateSelection;
      background?: boolean;
      active: boolean;
    };
