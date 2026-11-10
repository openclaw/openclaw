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
  modal?: boolean;
  selected: TemplateCatalogEntry | null;
  detail: TemplateCatalogDetail | null;
  /** Read only inside the detail contents Loading/Errored slot. */
  readDetail: () => TemplateCatalogDetail | null;
  detailRequest: Promise<TemplateCatalogDetail | null> | undefined;
  installedPluginPackages: ReadonlySet<string>;
  addError: string | null;
  applying: boolean;
  reviewing: boolean;
  canStartAdd: boolean;
  consentWarning: string | null;
  reviewPlan: TemplateAddReviewPlan | null;
  canAdd: boolean;
  preview?: {
    kind: "instruction" | "skill";
    name: string;
    content: string | null;
    request: Promise<void>;
  } | null;
  readPreview?: () => void;
  onClosePreview?: () => void;
  onOpenPreview: (kind: "instruction" | "skill", name: string) => void;
  onBack: () => void;
  onRetryCatalog: () => void;
  onRetryDetail: () => void;
  onConfirm: () => void | Promise<void>;
  onConfirmConsent: () => void | Promise<void>;
  onCancelConsent: () => void;
  onConfirmReview: () => void | Promise<void>;
  onCancelReview: () => void;
};
