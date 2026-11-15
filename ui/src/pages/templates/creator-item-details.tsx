import type { TemplateDraftReviewItem } from "@openclaw/gateway-protocol";
import { createMemo, Errored, For, Loading, Match, refresh, Show, Switch } from "solid-js";
import { FilePreviewDocument } from "../../components/file-preview-document.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { createSessionAutomationSchedule } from "../chat/components/session-automation-schedule-loader.ts";
import type { TemplateCreator } from "./creator-publication.ts";

function propertyValue(key: string, value: unknown): string {
  if (
    (key === "transport" || key === "auth") &&
    ["streamable-http", "sse", "stdio", "oauth"].includes(String(value))
  ) {
    return t("templatesDraft.serverValues." + String(value));
  }
  if (Array.isArray(value)) {
    return value.map((entry) => propertyValue("", entry)).join(", ");
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([name, entry]) => name + ": " + propertyValue("", entry))
      .join("\n");
  }
  return String(value);
}

function Properties(props: { rows: Array<[string, string]> }) {
  return (
    <dl class="template-creator__detail-panel template-creator__properties">
      <For each={props.rows}>
        {([key, value]) => (
          <div>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        )}
      </For>
    </dl>
  );
}

function PackagePreview(props: { flow: TemplateCreator; item: TemplateDraftReviewItem }) {
  const preview = createMemo(() => props.flow.readPackagePreview(props.item));
  const requirement = () => props.item.requirement!;
  const documentTitle = () => {
    const source = requirement();
    return source.source === "bundled"
      ? `${source.path}/SKILL.md`
      : t("templatesDraft.skillDocument", source);
  };
  const properties = createMemo<Array<[string, string]>>(() => {
    const source = requirement();
    const rows: Array<[string, string]> =
      source.source === "bundled"
        ? [
            [t("templatesDraft.package"), source.path],
            [t("templatesDraft.source"), t("templatesDraft.bundled")],
          ]
        : [
            [t("templatesDraft.package"), source.ref],
            [t("templatesDraft.version"), source.version],
            [t("templatesDraft.source"), "ClawHub"],
          ];
    return [...rows, [t("templatesDraft.installation"), t("templatesDraft.pluginInstallation")]];
  });
  return (
    <>
      <Errored
        fallback={(_error, retry) => (
          <p role="status">
            {t("templatesDraft.contentUnavailable")}{" "}
            <button
              type="button"
              class="btn"
              onClick={() => {
                void refresh(preview);
                retry();
              }}
            >
              {t("common.retry")}
            </button>
          </p>
        )}
      >
        <Loading on={props.item.id} fallback={<p role="status">{t("common.loading")}</p>}>
          <Show when={preview()?.description}>
            {(description) => (
              <div class="template-creator__detail-group">
                <h3>{t("templatesDraft.description")}</h3>
                <p class="template-creator__detail-panel">{description()}</p>
              </div>
            )}
          </Show>
          <Show when={props.item.kind === "skill"}>
            <div class="template-creator__detail-group">
              <h3>{documentTitle()}</h3>
              <div class="template-creator__detail-panel">
                <Show
                  when={preview()?.content}
                  fallback={<p role="status">{t("templatesDraft.contentUnavailable")}</p>}
                >
                  {(text) => <FilePreviewDocument path="SKILL.md" content={text()} markdown />}
                </Show>
              </div>
            </div>
          </Show>
        </Loading>
      </Errored>
      <Show when={props.item.kind === "plugin"}>
        <div class="template-creator__detail-group">
          <h3>{t("templatesDraft.packageDetails")}</h3>
          <Properties rows={properties()} />
        </div>
      </Show>
    </>
  );
}

/** All values come from the reviewed archive or its explicitly pinned package. */
export function TemplateItemDetails(props: {
  flow: TemplateCreator;
  item: TemplateDraftReviewItem;
}) {
  const schedule = createSessionAutomationSchedule();
  const server = createMemo(() => {
    if (props.item.kind !== "mcp") {
      return [];
    }
    // SAFETY: MCP details are serialized validated manifest entries from the review owner.
    const config = JSON.parse(props.item.detail) as Record<string, unknown>;
    return Object.entries(config);
  });
  return (
    <Switch fallback={<p class="template-creator__detail-panel">{props.item.detail}</p>}>
      <Match when={props.item.kind === "file"}>
        <div class="template-creator__detail-panel">
          <FilePreviewDocument path={props.item.label} content={props.item.detail} markdown />
        </div>
      </Match>
      <Match when={props.item.requirement}>
        <PackagePreview flow={props.flow} item={props.item} />
      </Match>
      <Match when={props.item.kind === "mcp"}>
        <div class="template-creator__detail-group">
          <h3>{t("templatesDraft.connectionDetails")}</h3>
          <Properties
            rows={[
              [t("templatesDraft.serverFields.server"), props.item.label],
              ...server().map(([key, value]): [string, string] => [
                t("templatesDraft.serverFields." + key),
                propertyValue(key, value),
              ]),
            ]}
          />
        </div>
      </Match>
      <Match when={props.item.automation}>
        {(automation) => (
          <>
            <div class="template-creator__detail-group">
              <h3>{t("templatesDraft.schedule")}</h3>
              <Loading fallback={<p role="status">{t("common.loading")}</p>}>
                <p class="template-creator__detail-panel">
                  {schedule({
                    kind: "cron",
                    expr: automation().schedule.cron,
                    tz: automation().schedule.timezone,
                  }) +
                    " · " +
                    automation().schedule.timezone}
                </p>
              </Loading>
            </div>
            <div class="template-creator__detail-group">
              <h3>{t("templatesDraft.message")}</h3>
              <div class="template-creator__detail-panel">
                <strong>{props.item.label}</strong>
                <p>
                  {t("templatesDraft." + automation().session + "Session") +
                    " · " +
                    t(
                      "templatesDraft." +
                        (automation().enabled ? "enabledInstallation" : "pausedInstallation"),
                    )}
                </p>
                <p class="template-creator__message">{automation().message}</p>
              </div>
            </div>
          </>
        )}
      </Match>
    </Switch>
  );
}
