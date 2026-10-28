import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createMemo,
  createSignal,
  Errored,
  For,
  isPending,
  lazy,
  latest,
  Loading,
  onSettled,
  Show,
} from "solid-js";
import type {
  McpAppMentionResult,
  McpAppResourceLink,
} from "../../../src/shared/mcp-app-extensions.js";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { formatUiError } from "../lib/format-error.ts";
import type { createMcpAppCatalog } from "../lib/mcp-app-catalog.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import {
  MCP_APP_RESOURCE_MENTION_EVENT,
  type McpAppResourceMentionDetail,
} from "./mcp-app-resource-mention.ts";
import { Icon } from "./solid/icon.tsx";

type McpAppResourcesProps = { sessionKey: string; agentId: string };

export function McpAppResourcesView(
  props: McpAppResourcesProps & {
    catalog: ReturnType<typeof createMcpAppCatalog>;
    host: () => HTMLElement;
  },
) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  let generation = 0;
  // Native inputs expose same-turn edits before their presentation signals settle.
  let queryInput: HTMLInputElement | undefined;
  let serverSelect: HTMLSelectElement | undefined;
  onSettled(() => () => {
    generation++;
  });
  const identity = createMemo(() => {
    gateway.read();
    return JSON.stringify([
      gatewayPresentationScope(context.gateway).key,
      props.sessionKey,
      props.agentId,
    ]);
  });
  // Keep each committed identity distinct even while the picker has no visible consumers.
  const requestScope = createMemo(() => ({ identity: identity() }));
  const [expanded, setExpanded] = createSignal(false);
  const [query, setQuery] = createSignal("");
  // Draft preferences persist; changing identity retires request feedback.
  const [visibleGeneration, setVisibleGeneration] = createSignal(() => {
    requestScope();
    return generation;
  });
  const [attachmentError, setAttachmentError] = createSignal<string | null>(() => {
    requestScope();
    return null;
  });
  const servers = createMemo(() =>
    props.catalog.snapshot().servers.filter((server) => server.mentionTool),
  );
  const [serverName, setServerName] = createSignal<string>((previous = "") => {
    const available = servers();
    return available.length && !available.some((server) => server.serverName === previous)
      ? available[0]!.serverName
      : previous;
  });

  type SearchRequest = {
    generation: number;
    current: () => boolean;
    promise: Promise<McpAppMentionResult | undefined>;
  };
  // Changing identity releases the old admitted promise and its plain result snapshots.
  const [request, setRequest] = createSignal<SearchRequest | undefined>(() => {
    requestScope();
    return undefined;
  });
  // The controls observe the same admitted promise without owning the answer's error boundary.
  const completion = createMemo(() => request()?.promise);
  const busy = () =>
    latest(request)?.generation === latest(visibleGeneration) && isPending(completion);

  // Empty result frames retain the existing margin while awaiting or reporting a search.
  function EmptyResults() {
    return (
      <Show when={expanded()}>
        <div class="mcp-app-resources__results" />
      </Show>
    );
  }

  function search() {
    const client = context.gateway.snapshot.client;
    const selectedServer = serverSelect?.value ?? serverName();
    if (!client || !props.catalog.available() || !selectedServer) {
      return;
    }
    const searchGeneration = ++generation;
    const searchScope = requestScope();
    const current = () =>
      props.host().isConnected &&
      generation === searchGeneration &&
      context.gateway.snapshot.client === client &&
      requestScope() === searchScope;
    // Admit from native inputs now; the memo only observes this request's answer.
    const promise = client
      .request<McpAppMentionResult>("mcp.app.mention", {
        sessionKey: props.sessionKey,
        agentId: props.agentId,
        serverName: selectedServer,
        query: queryInput?.value ?? query(),
      })
      .then(
        (value) => (current() ? value : undefined),
        (error: unknown) => {
          if (current()) {
            throw error;
          }
          return undefined;
        },
      );
    setRequest({ generation: searchGeneration, current, promise });
    setVisibleGeneration(searchGeneration);
    setAttachmentError(null);
  }
  function attach(resource: McpAppResourceLink, admitted: SearchRequest) {
    // Input changes retire retained result buttons before the next DOM commit.
    if (context.gateway.snapshot.phase !== "connected" || !admitted.current()) {
      return;
    }
    const claimed = !props.host().dispatchEvent(
      new CustomEvent<McpAppResourceMentionDetail>(MCP_APP_RESOURCE_MENTION_EVENT, {
        bubbles: true,
        composed: true,
        cancelable: true,
        detail: {
          sessionKey: props.sessionKey,
          agentId: props.agentId,
          serverName: serverName(),
          resource,
        },
      }),
    );
    if (claimed) {
      setExpanded(false);
    } else {
      setAttachmentError(t("mcpApp.errors.mountUnavailable"));
    }
  }
  return (
    <Show when={servers().length}>
      <section class="mcp-app-resources">
        <button
          type="button"
          class="btn btn--sm"
          aria-expanded={expanded() ? "true" : "false"}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon name="link" /> {t("mcpApp.resources")}
        </button>
        <Show when={expanded()}>
          <p class="muted">{t("mcpApp.resourceDescription")}</p>
          <form
            class="mcp-app-resources__search"
            onSubmit={(event) => {
              event.preventDefault();
              search();
            }}
          >
            <select
              ref={(element) => (serverSelect = element)}
              aria-label={t("mcpApp.title")}
              value={serverName()}
              disabled={busy()}
              onChange={(event) => {
                setServerName(event.currentTarget.value);
                setVisibleGeneration(++generation);
              }}
            >
              <For each={servers()} keyed={(server) => server.serverName}>
                {(server) => <option value={server().serverName}>{server().label}</option>}
              </For>
            </select>
            <input
              ref={(element) => (queryInput = element)}
              type="search"
              aria-label={t("mcpApp.resourceSearch")}
              placeholder={t("mcpApp.resourceQuery")}
              value={query()}
              onInput={(event) => {
                setQuery(event.currentTarget.value);
                setVisibleGeneration(++generation);
              }}
            />
            <button class="btn" type="submit" disabled={busy() || !props.catalog.available()}>
              {t("mcpApp.resourceSearch")}
            </button>
          </form>
        </Show>
        <Show when={latest(request)} keyed fallback={<EmptyResults />}>
          {(admitted) => {
            // Each search owns a fresh async read, so retries suspend instead of retaining errors.
            const answer = createMemo(() => admitted.promise);
            const Results = lazy(() => import("./mcp-app-resource-results.tsx"), {
              export: "McpAppResourceResults",
            });
            return (
              <Errored
                fallback={(error) => (
                  <>
                    <EmptyResults />
                    <p role="alert">
                      {asOptionalRecord(asOptionalRecord(error())?.details)?.code ===
                      "MCP_APP_UNSUPPORTED_MENTION_RESULT"
                        ? t("mcpApp.errors.unsupportedResources")
                        : formatUiError(error())}
                    </p>
                  </>
                )}
              >
                <Loading fallback={<EmptyResults />}>
                  <Show when={answer()} keyed fallback={<EmptyResults />}>
                    {(result) => (
                      <Show when={expanded()}>
                        <Show
                          when={admitted.generation === visibleGeneration()}
                          fallback={<EmptyResults />}
                        >
                          <Results
                            resources={result.resources}
                            disabled={busy() || !props.catalog.available()}
                            onAttach={(resource) => attach(resource, admitted)}
                          />
                        </Show>
                      </Show>
                    )}
                  </Show>
                </Loading>
              </Errored>
            );
          }}
        </Show>
        <Show when={attachmentError()}>
          <p role="alert">{attachmentError()}</p>
        </Show>
      </section>
    </Show>
  );
}
