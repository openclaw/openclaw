import type {
  ClawAddReviewPlan,
  ClawCatalogDetail,
  ClawCatalogEntry,
} from "./claws-catalog-client.ts";

export type ClawsCatalogViewProps = {
  /** Read only inside the catalog Loading/Errored slot. */
  readEntries: () => ClawCatalogEntry[];
  catalogRequest: Promise<ClawCatalogEntry[]> | undefined;
  basePath: string;
  selected: ClawCatalogEntry | null;
  detail: ClawCatalogDetail | null;
  /** Read only inside the detail contents Loading/Errored slot. */
  readDetail: () => ClawCatalogDetail | null;
  detailRequest: Promise<ClawCatalogDetail | null> | undefined;
  installedPluginPackages: ReadonlySet<string>;
  addError: string | null;
  applying: boolean;
  consentWarning: string | null;
  reviewPlan: ClawAddReviewPlan | null;
  addedAgentId: string | null;
  canAdd: boolean;
  onOpenPreview: (kind: "instruction" | "skill", name: string) => void;
  onBack: () => void;
  onRetryCatalog: () => void;
  onRetryDetail: () => void;
  onConfirm: () => void | Promise<void>;
  onConfirmConsent: () => void | Promise<void>;
  onCancelConsent: () => void;
  onConfirmReview: () => void | Promise<void>;
  onCancelReview: () => void;
  onRetryOpenChat: () => void | Promise<void>;
};
