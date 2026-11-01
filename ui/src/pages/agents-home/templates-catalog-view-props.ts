import type {
  TemplateAddReviewPlan,
  TemplateCatalogDetail,
  TemplateCatalogEntry,
} from "./templates-catalog-client.ts";

export type TemplatesCatalogViewProps = {
  /** Read only inside the catalog Loading/Errored slot. */
  readEntries: () => TemplateCatalogEntry[];
  catalogRequest: Promise<TemplateCatalogEntry[]> | undefined;
  basePath: string;
  selected: TemplateCatalogEntry | null;
  detail: TemplateCatalogDetail | null;
  /** Read only inside the detail contents Loading/Errored slot. */
  readDetail: () => TemplateCatalogDetail | null;
  detailRequest: Promise<TemplateCatalogDetail | null> | undefined;
  installedPluginPackages: ReadonlySet<string>;
  addError: string | null;
  applying: boolean;
  consentWarning: string | null;
  reviewPlan: TemplateAddReviewPlan | null;
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
