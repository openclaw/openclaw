import { createMemo, createStore, For, Show } from "solid-js";
import type { SessionDiffFile } from "../../../../../packages/gateway-protocol/src/index.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { StrokeIcon } from "../../../components/solid/stroke-icon.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerChatSessionOptionalEnglish } from "../../../i18n/locales/en-chat-session-optional.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { AttachmentFileIcon } from "./chat-attachment-file-icon-solid.tsx";
import { DiffStatChips } from "./chat-diff-stat.solid.tsx";
import { FileDisclosure } from "./file-disclosure.tsx";

registerEnglishCatalog(registerChatSessionOptionalEnglish);

type ReviewNode = { key: string; name: string; path: string } & (
  | { kind: "file"; file: SessionDiffFile; children: [] }
  | { kind: "directory"; file?: never; children: ReviewNode[] }
);
type ReviewDirectory = Extract<ReviewNode, { kind: "directory" }>;

export function ReviewFilename(props: { name: string }) {
  const split = createMemo(() => {
    const compound = props.name.match(/\.(?:d\.ts|tar\.gz)$/i);
    return compound
      ? props.name.length - compound[0].length
      : Math.max(0, props.name.lastIndexOf("."));
  });
  return (
    <span class="session-diff__filename-label">
      <span ref={createTextOverflow(() => props.name)} class="session-diff__basename">
        {split() ? props.name.slice(0, split()) : props.name}
      </span>
      {split() > 0 && <span class="session-diff__extension">{props.name.slice(split())}</span>}
    </span>
  );
}

/** Projection of the current Git scope only; never loads or owns the Files catalog. */
function reviewTree(files: readonly SessionDiffFile[], query: string): ReviewNode[] {
  const root: ReviewDirectory = {
    kind: "directory",
    key: "directory:",
    name: "",
    path: "",
    children: [],
  };
  const filter = query.trim().toLocaleLowerCase();
  for (const file of files) {
    if (filter && !file.path.toLocaleLowerCase().includes(filter)) {
      continue;
    }
    const parts = file.path.replace(/\/$/, "").split("/");
    let parent = root;
    for (let index = 0; index < parts.length - 1; index++) {
      const name = parts[index]!;
      const path = parts.slice(0, index + 1).join("/");
      const key = `directory:${path}`;
      let node = parent.children.find(
        (entry): entry is ReviewDirectory => entry.kind === "directory" && entry.key === key,
      );
      if (!node) {
        node = { kind: "directory", key, name, path, children: [] };
        parent.children.push(node);
      }
      parent = node;
    }
    // Git can replace a file with a directory (or the reverse) in one diff.
    // Keep the changed file and the directory at that path as distinct siblings.
    parent.children.push({
      kind: "file",
      key: `file:${file.path}`,
      name: parts.at(-1)!,
      path: file.path,
      file,
      children: [],
    });
  }
  function compact(nodes: ReviewNode[]): ReviewNode[] {
    return nodes
      .map((initialNode) => {
        let node = initialNode;
        while (
          node.kind === "directory" &&
          node.children.length === 1 &&
          node.children[0]!.kind === "directory"
        ) {
          const child = node.children[0]!;
          node = { ...child, name: `${node.name}/${child.name}` };
        }
        return node.kind === "directory" ? { ...node, children: compact(node.children) } : node;
      })
      .toSorted(
        (a, b) =>
          Number(a.kind === "file") - Number(b.kind === "file") || a.name.localeCompare(b.name),
      );
  }
  return compact(root.children);
}

export function SessionDiffTree(props: {
  files: readonly SessionDiffFile[];
  query: string;
  selected: string | null;
  statsAvailable: boolean;
  onSelect: (path: string) => void;
  active: boolean;
  instant: boolean;
}) {
  const nodes = createMemo(() => reviewTree(props.files, props.query));
  // A new search opens matching directories; local toggles survive other refreshes.
  const [closed, setClosed] = createStore<Record<string, true>>(() => {
    void props.query;
    return Object.create(null);
  });
  function Rows(row: { nodes: ReviewNode[] }) {
    return (
      <ul>
        <For each={row.nodes} keyed={(node) => node.key}>
          {(node) => {
            const expanded = () => !closed[node().key];
            return (
              <li>
                <button
                  type="button"
                  class={[
                    "session-diff__tree-row",
                    { "is-selected": props.selected === node().file?.path },
                  ]}
                  title={node().path}
                  aria-current={props.selected === node().file?.path ? "true" : undefined}
                  aria-expanded={node().file ? undefined : expanded() ? "true" : "false"}
                  onClick={() => {
                    const file = node().file;
                    if (file) {
                      props.onSelect(file.path);
                    } else {
                      setClosed((draft) => {
                        const key = node().key;
                        if (draft[key]) {
                          delete draft[key];
                        } else {
                          draft[key] = true;
                        }
                      });
                    }
                  }}
                >
                  <span class="session-diff__tree-name">
                    {node().file ? (
                      <AttachmentFileIcon filename={node().name} mode="preview-with-favicon" />
                    ) : (
                      <Show when={expanded()} fallback={<Icon name="folder" />}>
                        <StrokeIcon aria-hidden="true">
                          <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
                        </StrokeIcon>
                      </Show>
                    )}
                    {node().file ? (
                      <ReviewFilename name={node().name} />
                    ) : (
                      <span ref={createTextOverflow(() => node().name)} title={node().name}>
                        {node().name}
                      </span>
                    )}
                  </span>
                  <Show when={props.statsAvailable && node().file}>
                    {(file) => (
                      <DiffStatChips
                        stat={{ added: file().additions, removed: file().deletions }}
                      />
                    )}
                  </Show>
                </button>
                <Show when={!node().file}>
                  <FileDisclosure
                    variant="review"
                    open={expanded()}
                    active={props.active}
                    instant={props.instant}
                  >
                    <Rows nodes={node().children} />
                  </FileDisclosure>
                </Show>
              </li>
            );
          }}
        </For>
      </ul>
    );
  }
  return (
    <nav class="session-diff__tree" aria-label={t("chat.sessionDiff.fileTree")}>
      <Show
        when={nodes().length > 0}
        fallback={<p class="muted">{t("chat.sessionDiff.noMatchingFiles")}</p>}
      >
        <Rows nodes={nodes()} />
      </Show>
    </nav>
  );
}
