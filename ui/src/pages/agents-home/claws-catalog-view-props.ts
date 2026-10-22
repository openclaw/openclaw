import type {
  ClawAddReviewPlan,
  ClawCatalogDetail,
  ClawCatalogEntry,
} from "./claws-catalog-client.ts";

export type ClawsCatalogViewProps = {
  entries: ClawCatalogEntry[];
  basePath: string;
  query: string;
  loading: boolean;
  error: string | null;
  selected: ClawCatalogEntry | null;
  pageMode: boolean;
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
  onSearch: (query: string) => void;
  onSelect: (entry: ClawCatalogEntry) => void;
  onBack: () => void;
  onClose: () => void;
  onRetryCatalog: () => void;
  onRetryDetail: () => void;
  onConfirm: () => void;
  onConfirmConsent: () => void;
  onCancelConsent: () => void;
  onConfirmReview: () => void;
  onCancelReview: () => void;
  onRetryOpenChat: () => void;
};
