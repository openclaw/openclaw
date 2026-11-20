import type {
  SkillsDetailResult,
  SkillsFileGetResult,
  SkillsLibraryReadResult,
} from "@openclaw/gateway-protocol";
import type { JSX } from "@solidjs/web";
import { createMemo, Errored, Loading, refresh, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SkillStatusReport } from "../../api/types.ts";
import {
  FilePreviewDocument,
  filePreviewDocumentLink,
} from "../../components/file-preview-document.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { SkillsState } from "../../lib/skills/index.ts";
import "../../styles/sidebar-markdown.css";
import { renderPluginDetailShell as DetailShell } from "../plugins/detail-shell.tsx";
import { renderPluginOfficialBadge } from "../plugins/plugin-card.tsx";
import type { SkillCatalogTarget } from "./catalog-location.ts";
import { SkillStateStatus, verdictForSkill } from "./skill-status.tsx";

type Document = {
  name: string;
  content?: string;
  error?: string;
  author?: string;
  summary?: string;
  official?: boolean;
  enabled?: boolean;
  version?: string;
  icon?: string;
};

export function SkillCatalogDetail(props: {
  target: SkillCatalogTarget;
  client: GatewayBrowserClient | null;
  connected: boolean;
  epoch: number;
  agentId: string | null;
  report: SkillStatusReport | null;
  inventoryError: string | null;
  backHref: string;
  onBack: () => void;
  onSettings: () => void;
  verdicts: SkillsState["clawhubVerdicts"];
  iconUrls: SkillsState["clawhubIconUrls"];
  canInstall: boolean;
  personal: boolean;
  installMessage: SkillsState["clawhubInstallMessage"];
  onInstall: (ref: string, version?: string) => void;
}) {
  const local = createMemo(() =>
    props.target.kind === "local"
      ? props.report?.skills.find((skill) => skill.skillKey === props.target.key)
      : undefined,
  );
  const path = createMemo(() => local()?.filePath);
  // Replacing a target or access scope disposes its entire read boundary, including late results.
  const scope = createMemo(
    () => ({
      client: props.connected ? props.client : null,
      agentId: props.agentId,
      epoch: props.epoch,
      path: path(),
    }),
    {
      equals: (a, b) =>
        a.client === b.client &&
        a.agentId === b.agentId &&
        a.epoch === b.epoch &&
        a.path === b.path,
    },
  );
  const status = (message: string) => (
    <p class="muted" role="status">
      {message}
    </p>
  );
  const issue = (message: string) => (
    <InlineAlert tone="danger" role="alert">
      {message}
    </InlineAlert>
  );
  const installMessage = () =>
    props.installMessage?.ref === props.target.key ? props.installMessage : null;
  function Shell(shell: { doc?: Document; panel: JSX.Element }) {
    const skill = () => local();
    const name = () => shell.doc?.name ?? skill()?.name ?? props.target.key;
    const image = () => shell.doc?.icon && props.iconUrls[shell.doc.icon];
    return (
      <DetailShell
        id="skill-catalog-detail"
        name={name()}
        summary={shell.doc?.summary ?? skill()?.description}
        backHref={props.backHref}
        backLabel={t("tabs.skills")}
        onBack={() => props.onBack()}
        icon={
          image() ? <img src={image()} alt="" /> : (skill()?.emoji ?? <Icon name="bookOpenText" />)
        }
        identity={
          <span class="plugin-card-author">
            {shell.doc?.author ?? skill()?.source}{" "}
            {shell.doc?.official && renderPluginOfficialBadge()}
          </span>
        }
        titleAction={
          <>
            <Show when={skill()}>
              {(entry) => (
                <SkillStateStatus
                  skill={entry()}
                  verdict={verdictForSkill(entry(), props.verdicts)}
                  showLabel
                />
              )}
            </Show>
            {shell.doc?.enabled !== undefined && (
              <SkillStateStatus skill={{ disabled: !shell.doc.enabled }} showLabel />
            )}
            {props.target.kind !== "remote" ? (
              <button
                type="button"
                class="btn oc-action oc-action-secondary"
                onClick={() => props.onSettings()}
              >
                {t("skillDiscovery.settings")}
              </button>
            ) : (
              shell.doc && (
                <button
                  type="button"
                  class="btn oc-action oc-action-primary"
                  disabled={!props.canInstall || installMessage()?.kind === "success"}
                  onClick={() => props.onInstall(props.target.key, shell.doc?.version)}
                >
                  {t(
                    installMessage()?.kind === "success"
                      ? "skillsPage.installed"
                      : props.personal
                        ? "skillLibrary.import"
                        : "skillsPage.install",
                  )}
                </button>
              )
            )}
            <Show when={installMessage()}>
              {(message) => (
                <InlineAlert tone={message().kind === "error" ? "danger" : "success"}>
                  {message().text}
                </InlineAlert>
              )}
            </Show>
          </>
        }
        panel={shell.panel}
      />
    );
  }
  return (
    <SettingsPage carapace>
      <Show when={scope()} keyed>
        {(current) => {
          const doc = createMemo(async (): Promise<Document | null> => {
            const client = current.client;
            if (!client || !current.agentId) return null;
            const { kind, key } = props.target;
            if (kind === "local") {
              if (!current.path) return null;
              const file = await client.request<SkillsFileGetResult>("skills.files.get", {
                agentId: current.agentId,
                path: current.path,
              });
              return { name: file.name, content: file.content };
            }
            if (kind === "library") {
              const file = await client.request<SkillsLibraryReadResult>("skills.library.read", {
                skillId: key,
              });
              return {
                name: file.entry.slug,
                author: file.entry.ownerLabel,
                summary: file.entry.description,
                enabled: file.entry.enabled,
                content: file.content,
              };
            }
            const detail = await client.request<SkillsDetailResult>("skills.detail", {
              slug: key,
              includeInstructions: true,
            });
            if (!detail.skill) return null;
            return {
              name: detail.skill.displayName,
              summary: detail.skill.summary ?? undefined,
              author: detail.owner?.handle
                ? "@" + detail.owner.handle
                : (detail.owner?.displayName ?? undefined),
              icon: detail.skill.icon ?? undefined,
              official: detail.skill.isOfficial === true,
              version: detail.latestVersion?.version,
              ...(detail.instructions?.status === "available"
                ? { content: detail.instructions.content }
                : {
                    error: detail.instructions?.reason ?? t("skillDiscovery.documentUnavailable"),
                  }),
            };
          });
          return (
            <Errored
              fallback={(error, reset) => (
                <Shell
                  panel={
                    <InlineAlert tone="danger" role="alert">
                      {formatUiError(error())}{" "}
                      <button
                        class="btn btn--sm"
                        onClick={() => {
                          void refresh(doc);
                          reset();
                        }}
                      >
                        {t("common.retry")}
                      </button>
                    </InlineAlert>
                  }
                />
              )}
            >
              <Loading fallback={<Shell panel={status(t("common.loading"))} />}>
                <Show
                  when={doc()}
                  fallback={
                    <Shell
                      panel={
                        !props.connected
                          ? status(t("skillsPage.disconnected"))
                          : !current.client
                            ? issue(t("skillDiscovery.readRequired"))
                            : props.inventoryError
                              ? issue(props.inventoryError)
                              : props.target.kind === "local" && !props.report
                                ? status(t("common.loading"))
                                : status(t("skillsPage.notFound"))
                      }
                    />
                  }
                >
                  {(file) => (
                    <Shell
                      doc={file()}
                      panel={
                        file().error ? (
                          <InlineAlert tone="warning" role="alert">
                            {formatUiExternalText(file().error)}{" "}
                            <button class="btn btn--sm" onClick={() => void refresh(doc)}>
                              {t("common.retry")}
                            </button>
                          </InlineAlert>
                        ) : (
                          <div class="plugin-catalog-detail__readme sidebar-markdown">
                            <FilePreviewDocument
                              path="SKILL.md"
                              content={file().content ?? ""}
                              markdown
                              onClick={(event) => {
                                filePreviewDocumentLink(event, "SKILL.md");
                              }}
                            />
                          </div>
                        )
                      }
                    />
                  )}
                </Show>
              </Loading>
            </Errored>
          );
        }}
      </Show>
    </SettingsPage>
  );
}
