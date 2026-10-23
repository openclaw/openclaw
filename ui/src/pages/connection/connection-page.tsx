import "../../styles/connection.css";
import { createDeferred, createMemo, createSignal, onSettled } from "solid-js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { LearnMoreLink, SettingsPageHeader } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { useVisiblePoll } from "../../lib/reactive/visible-poll.ts";
import { SYSTEM_INFO_POLL_INTERVAL_MS } from "../../lib/system-info.ts";
import { ConnectionDraft } from "./connection-draft.ts";
import { ConnectionView } from "./view.tsx";

const CONNECTION_DOCS_URL = "https://docs.openclaw.ai/gateway/remote";

export function ConnectionPage() {
  const context = useApplication();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const changed = () => setRevision((value) => value + 1);
  const draft = new ConnectionDraft(context, changed);
  draft.polling = useVisiblePoll(SYSTEM_INFO_POLL_INTERVAL_MS, () => draft.refreshDiagnostics());
  draft.gateway = useGatewayPage({
    getGateway: () => context.gateway,
    invalidateRequests: () => draft.dispose(),
    onSnapshot: (change) => {
      draft.handleGatewaySnapshot(change);
      changed();
    },
    onPageActivation: () => draft.syncDiagnosticsPolling(),
  });
  onSettled(() => () => draft.dispose());
  const viewProps = () => {
    revision();
    return draft.viewProps();
  };
  const systemInfoReceipt = createMemo(
    () => {
      revision();
      return { completion: draft.systemInfoRead, failed: draft.statusFailed };
    },
    {
      equals: (previous, next) =>
        previous.completion === next.completion && previous.failed === next.failed,
    },
  );
  // Revalidation retains host data without holding live connection/draft changes.
  const systemInfoReady = createDeferred(() => {
    const receipt = systemInfoReceipt();
    return receipt.completion ?? receipt.failed;
  });
  return (
    <openclaw-connection-page>
      <SettingsPageHeader
        title={titleForRoute("connection", t)}
        subtitle={
          <>
            {subtitleForRoute("connection", t)} <LearnMoreLink url={CONNECTION_DOCS_URL} />
          </>
        }
      />
      <SettingsWorkspace>
        <ConnectionView {...viewProps()} systemInfoReady={systemInfoReady} />
      </SettingsWorkspace>
    </openclaw-connection-page>
  );
}
