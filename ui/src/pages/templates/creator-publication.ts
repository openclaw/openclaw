import type {
  TemplateDraftReviewChoices,
  TemplatesDraftsPublishResult,
  TemplatesDraftsReviewResult,
} from "@openclaw/gateway-protocol";
import { createChangeListeners } from "../../../../src/shared/listeners.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";

// Dormant presentation and the cold implementation share a contract without
// importing each other's modules or constructing the flow during chat boot.
export interface TemplateCreator {
  busy: "starting" | "reviewing" | "publishing" | null;
  review: TemplatesDraftsReviewResult | null;
  reviewRead: { result: Promise<void> } | null;
  reviewCurrent: boolean;
  choices: TemplateDraftReviewChoices | null;
  modalOpen: boolean;
  publication: TemplatesDraftsPublishResult | null;
  error: string | null;
  presentationLifetime: PromiseWithResolvers<void>;
  readonly hasActiveDraft: boolean;
  readonly subscribe: (listener: () => void) => () => void;
  retirePresentation(): void;
  start(agentId: string): Promise<void>;
  open(agentId: string, draftId: string): void;
  updateChoices(next: TemplateDraftReviewChoices): void;
  publish(): Promise<void>;
  close(): void;
  reopen(): void;
  retryReview(): void;
}

type PendingStart = { agentId: string; client: GatewayBrowserClient; revision: number };
export type CreatorOwner = {
  flow: TemplateCreator | null;
  pending: PendingStart | null;
  loading: boolean;
  subscribe: (listener: () => void) => () => void;
  publish: () => void;
};

const owners = new WeakMap<ApplicationContext, CreatorOwner>();

/** Observe publication without constructing the optional creator runtime. */
export function templateCreatorOwner(context: ApplicationContext): CreatorOwner {
  let owner = owners.get(context);
  if (!owner) {
    owner = { flow: null, pending: null, loading: false, ...createChangeListeners() };
    owners.set(context, owner);
  }
  return owner;
}
