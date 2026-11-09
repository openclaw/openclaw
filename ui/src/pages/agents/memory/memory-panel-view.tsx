import { createMemo, latest } from "solid-js";
import type { AgentMemoryState } from "./memory-panel-state.ts";
import { renderDreamingToggleConfirmation as DreamingToggleConfirmation } from "./toggle-confirmation.tsx";
import { renderDreaming as Dreaming } from "./view.tsx";

export function AgentMemoryView(props: { state: AgentMemoryState }) {
  const model = createMemo(() => props.state.view());
  // Interrupted/confirmed receipts remain visible while a retired action is still pending.
  const diaryOutcome = () => latest(() => props.state.diaryOutcome());
  return (
    <>
      <Dreaming
        {...model().dreaming}
        header={model().header}
        onRefresh={() => void props.state.loadResources("all", true)}
        onSetEnabled={(enabled) => props.state.setEnabled(enabled)}
        configOpening={props.state.configOpening()}
        dreamDiaryActionLoading={props.state.diaryActionBusy()}
        dreamDiaryActionMessage={diaryOutcome().message}
        dreamDiaryActionArchivePath={diaryOutcome().archivePath}
      />
      <DreamingToggleConfirmation {...model().toggle} />
    </>
  );
}
