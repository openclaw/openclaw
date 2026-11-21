import type { TemplatePluginPresentation } from "./template-plugin-icon.tsx";
import type { TemplateAddFailure } from "./templates-add-agent.ts";
import type { TemplateCatalogDetail, TemplateCatalogEntry } from "./templates-catalog-client.ts";

export type TemplatesCatalogViewProps = {
  basePath: string;
  modal?: boolean;
  selected: TemplateCatalogEntry | null;
  detail: TemplateCatalogDetail | null;
  /** Read only inside the detail contents Loading/Errored slot. */
  readDetail: () => TemplateCatalogDetail | null;
  detailRequest: Promise<TemplateCatalogDetail | null> | undefined;
  installedPluginPackages: ReadonlySet<string>;
  pluginPresentation?: Readonly<Record<string, TemplatePluginPresentation>>;
  addFailure: Pick<TemplateAddFailure, "entry" | "message"> | null;
  applying: boolean;
  consentWarning: string | null;
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
  /** The whole text of one workspace file of the shown release. */
  readInstruction?: (name: string) => Promise<string>;
  onBack: () => void;
  onRetryDetail: () => void;
  onConfirm: () => void | Promise<void>;
  onConfirmConsent: () => void | Promise<void>;
  onCancelConsent: () => void;
};
