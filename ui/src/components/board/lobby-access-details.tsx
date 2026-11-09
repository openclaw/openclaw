import { For, Show } from "solid-js";
import type { BoardWidget } from "../../lib/board/types.ts";
import { t } from "../../lib/reactive/i18n.ts";

type Parameter = readonly [string, string | number | boolean | null];

function readableName(value: string) {
  const words = value.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/[._:-]+/gu, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function AccessDetails(props: { id: string; parameters?: readonly Parameter[] }) {
  return (
    <details class="lobby-access__details">
      <summary>{t("board.lobby.accessDetails")}</summary>
      <dl>
        <dt>{t("board.lobby.capability")}</dt>
        <dd>{props.id}</dd>
        <For each={props.parameters ?? []} keyed={false}>
          {(entry) => (
            <>
              <dt>{readableName(entry()[0])}</dt>
              <dd>{entry()[1] === null ? t("board.lobby.anyValue") : String(entry()[1])}</dd>
            </>
          )}
        </For>
      </dl>
    </details>
  );
}

/** Human descriptions come from the active plugin catalog; exact scope stays inspectable as fields. */
export function LobbyAccessDetails(props: { widget: BoardWidget }) {
  const bindings = () => props.widget.declared?.actionBindings ?? [];
  const tools = () =>
    (props.widget.declared?.tools ?? []).filter(
      (id) => !bindings().some((binding) => binding.actionId === id),
    );
  const queries = () => props.widget.declared?.queries ?? [];
  const usesConnectedAccounts = () =>
    queries().length > 0 || tools().some((id) => id.startsWith("github.actions"));
  return (
    <div class="lobby-access__requests">
      <Show when={props.widget.declared?.netOrigins?.length}>
        <section>
          <h4>{t("board.lobby.websites")}</h4>
          <ul>
            <For each={props.widget.declared?.netOrigins ?? []} keyed={false}>
              {(origin) => <li>{origin()}</li>}
            </For>
          </ul>
        </section>
      </Show>
      <For each={bindings()} keyed={(binding) => binding.name}>
        {(binding) => (
          <section>
            <h4>{readableName(binding().name)}</h4>
            <Show when={props.widget.capabilityDescriptions?.[binding().actionId]}>
              {(description) => <p>{description()}</p>}
            </Show>
            <AccessDetails id={binding().actionId} parameters={Object.entries(binding().params)} />
          </section>
        )}
      </For>
      <For each={tools()} keyed={false}>
        {(id) => (
          <section>
            <h4>
              {id().startsWith("cron.trigger:")
                ? t("board.lobby.runAutomation")
                : id() === "prompt"
                  ? t("board.lobby.messageAgent")
                  : readableName(id())}
            </h4>
            <Show when={props.widget.capabilityDescriptions?.[id()]}>
              {(description) => <p>{description()}</p>}
            </Show>
            <AccessDetails id={id()} />
          </section>
        )}
      </For>
      <For each={queries()} keyed={(query) => query.name}>
        {(query) => (
          <section>
            <h4>{readableName(query().name)}</h4>
            <p>
              {props.widget.capabilityDescriptions?.[query().bindingId] ??
                t("board.lobby.workflowData")}
            </p>
            <AccessDetails
              id={query().bindingId}
              parameters={[
                ...Object.entries(query().params),
                [t("board.lobby.fields"), query().fields.map(readableName).join(", ")],
              ]}
            />
          </section>
        )}
      </For>
      <Show when={usesConnectedAccounts()}>
        <p class="muted">{t("board.lobby.connectedAccountAccess")}</p>
      </Show>
    </div>
  );
}
