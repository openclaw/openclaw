import type { ApplicationContext } from "../../app/context-types.ts";
import { UsagePageShell } from "./page-shell.tsx";
import type { UsageProps } from "./types.ts";
import type { UsagePageModel } from "./usage-page-model.ts";
import { renderUsage as UsageView } from "./view.tsx";

export function UsagePageContent(props: {
  state: UsageProps;
  context: ApplicationContext;
  result: UsagePageModel["usageResult"];
}) {
  return (
    <UsagePageShell context={props.context} result={props.result}>
      <UsageView {...props.state} />
    </UsagePageShell>
  );
}
