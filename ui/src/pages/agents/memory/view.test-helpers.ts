import { flush } from "solid-js";
import { i18n } from "../../../i18n/index.ts";
import { registerDreamingEnglish } from "../../../i18n/locales/en-dreaming.ts";
import { en } from "../../../i18n/locales/en.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { renderDreaming } from "./view.tsx";

export const fullDreamingViewAccess: Parameters<typeof renderDreaming>[0]["access"] = {
  canOpenConfig: true,
  canBackfillDiary: true,
  canDedupeDreamDiary: true,
  canResetDiary: true,
  canResetGroundedShortTerm: true,
  canRepairDreamingArtifacts: true,
};

type DreamingProps = Parameters<typeof renderDreaming>[0];

export function createDreamingViewProps(
  viewState: DreamingProps["viewState"],
  overrides: Partial<DreamingProps> = {},
): DreamingProps {
  const props: DreamingProps = {
    access: fullDreamingViewAccess,
    viewState,
    active: true,
    selectedAgentId: "main",
    statusError: null,
    readStatus: () => null,
    readStatusData: () => ({
      shortTermCount: 0,
      promotedCount: 0,
      shortTermEntries: [],
      promotedEntries: [],
      phases: undefined,
      nextCycle: null,
      timezone: null,
    }),
    readDiary: () => props.dreamDiaryContent,
    readImports: () => props.wikiImportInsights,
    readOverview: () => props.wikiOverview,
    modeSaving: false,
    dreamDiaryLoading: false,
    dreamDiaryActionLoading: false,
    dreamDiaryActionMessage: null,
    dreamDiaryActionArchivePath: null,
    dreamDiaryContent: null,
    memoryWikiEnabled: true,
    wikiImportInsightsLoading: false,
    wikiImportInsights: null,
    wikiOverviewLoading: false,
    wikiOverview: null,
    onRefreshDiary: () => {},
    onRefreshImports: () => {},
    onRefreshWikiOverview: () => {},
    onOpenConfig: async () => {},
    onOpenWikiPage: async () => {},
    onCloseWikiPreview: () => {},
    wikiPreview: null,
    onBackfillDiary: () => {},
    onCopyDreamingArchivePath: () => {},
    onDedupeDreamDiary: () => {},
    onResetDiary: () => {},
    onResetGroundedShortTerm: () => {},
    onRepairDreamingArtifacts: () => {},
    onViewStateChange: (update) => update(viewState),
    ...overrides,
  };
  return props;
}

export function installDreamingViewTestTranslations(): () => void {
  i18n.registerTranslation("en", { ...en, ...registerDreamingEnglish.catalog });
  return () => i18n.registerTranslation("en", en);
}

const mounts = new WeakMap<HTMLElement, () => void>();

export function renderDreamingView(props: DreamingProps, container: HTMLElement) {
  mounts.get(container)?.();
  const mounted = mountSolid(() => renderDreaming(props), { container });
  mounts.set(container, mounted.unmount);
  flush();
}
