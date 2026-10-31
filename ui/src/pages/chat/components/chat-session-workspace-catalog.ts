import type { SessionWorkspaceListResult } from "../../../api/types.ts";
import { sessionWorkspaceFileKey } from "../../../lib/sessions/workspace.ts";
import type {
  SessionWorkspaceDirectory,
  SessionWorkspaceFilter,
} from "./chat-sidebar-content-types.ts";

type BrowserEntry = NonNullable<SessionWorkspaceListResult["browser"]>["entries"][number];
export type WorkspaceCatalogFile = {
  key: string;
  path: string;
  name: string;
  origin: "session" | "workspace";
  workspacePath?: string;
  activity?: "modified" | "read" | "mixed";
  artifactId?: string;
  mimeType?: string;
};
export type WorkspaceCatalogRow = WorkspaceCatalogFile & { directory: boolean };

export function splitWorkspaceFilename(name: string): { stem: string; extension: string } {
  const suffix = name.match(/(?:\.d\.(?:ts|mts|cts)|\.tar\.(?:gz|bz2|xz|zst)|\.[^.]+)$/i)?.[0];
  return suffix && suffix.length < name.length
    ? { stem: name.slice(0, -suffix.length), extension: suffix }
    : { stem: name, extension: "" };
}

const absolutePath = (path: string) => /^(?:\/|[a-z]:[\\/])/i.test(path);
const parentPath = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const activityMatches = (
  activity: WorkspaceCatalogFile["activity"],
  filter: SessionWorkspaceFilter,
) =>
  filter === "all" ||
  (filter === "changed"
    ? activity === "modified" || activity === "mixed"
    : filter === "read" && (activity === "read" || activity === "mixed"));

function mergeActivity(
  previous: WorkspaceCatalogFile["activity"],
  next: WorkspaceCatalogFile["activity"],
): WorkspaceCatalogFile["activity"] {
  if (!previous) {
    return next;
  }
  if (!next || previous === next) {
    return previous;
  }
  return "mixed";
}

/** Projection of actual listed/touched paths. It never scans or fetches a tree. */
export function projectWorkspaceCatalog(
  list: SessionWorkspaceListResult | null,
  directories: Readonly<Record<string, Pick<SessionWorkspaceDirectory, "browser">>> = {},
) {
  const project = new Map<string, WorkspaceCatalogRow>();
  const session = new Map<string, WorkspaceCatalogFile>();
  const sessionKey = list?.sessionKey ?? "";
  const fileKey = (path: string) => sessionWorkspaceFileKey(sessionKey, list?.root, path);
  const addParents = (path: string) => {
    let parent = parentPath(path);
    while (parent) {
      if (!project.has(parent)) {
        project.set(parent, {
          key: fileKey(parent),
          path: parent,
          workspacePath: parent,
          name: parent.split("/").at(-1)!,
          origin: "workspace",
          directory: true,
        });
      }
      parent = parentPath(parent);
    }
  };
  const addEntry = (entry: BrowserEntry) => {
    project.set(entry.path, {
      key: fileKey(entry.path),
      path: entry.path,
      workspacePath: entry.path,
      name: entry.name,
      origin: "workspace",
      activity: mergeActivity(project.get(entry.path)?.activity, entry.sessionKind),
      directory: entry.kind === "directory",
    });
    addParents(entry.path);
  };
  for (const directory of Object.values(directories)) {
    for (const entry of directory.browser?.entries ?? []) {
      addEntry(entry);
    }
  }
  if (!list?.browser?.search) {
    for (const entry of list?.browser?.entries ?? []) {
      addEntry(entry);
    }
  }
  for (const file of list?.files ?? []) {
    // Session request paths are cwd-relative; only workspacePath establishes root identity.
    const path = file.workspacePath;
    const entry: WorkspaceCatalogFile = {
      key: path === undefined ? `file:${file.path}` : fileKey(path),
      path: file.path,
      workspacePath: file.workspacePath,
      name: file.name,
      origin: "session",
      activity: file.kind,
      mimeType: file.mimeType,
    };
    if (path === undefined || absolutePath(path)) {
      session.set(entry.key, {
        ...entry,
        activity: mergeActivity(session.get(entry.key)?.activity, entry.activity),
      });
    } else {
      project.set(path, {
        ...entry,
        activity: mergeActivity(project.get(path)?.activity, entry.activity),
        directory: false,
      });
      addParents(path);
    }
  }
  for (const artifact of list?.artifacts ?? []) {
    const key = `artifact:${artifact.id}`;
    session.set(key, {
      key,
      path: artifact.title,
      name: artifact.title,
      origin: "session",
      artifactId: artifact.id,
      mimeType: artifact.mimeType,
    });
  }
  const sources = { session: [...session.values()], project };
  return { ...sources, filters: workspaceCatalogFilters(sources) };
}

/** Folder views can display only their project subtree, never session-only sources. */
export function workspaceCatalogFilters(
  catalog: {
    project: ReadonlyMap<string, WorkspaceCatalogRow>;
    session: readonly WorkspaceCatalogFile[];
  },
  folderPath?: string,
): SessionWorkspaceFilter[] {
  const files = [...catalog.project.entries()]
    .filter(
      ([path, entry]) =>
        !entry.directory &&
        (folderPath === undefined || folderPath === "" || path.startsWith(`${folderPath}/`)),
    )
    .map(([, entry]) => entry);
  const sources = folderPath === undefined ? [...files, ...catalog.session] : files;
  return (["all", "changed", "read", "artifacts"] as const).filter(
    (filter) =>
      filter === "all" ||
      sources.some((entry) =>
        filter === "artifacts"
          ? Boolean(entry.artifactId)
          : activityMatches(entry.activity, filter),
      ),
  );
}

export function workspaceCatalogChildren(
  catalog: { project: ReadonlyMap<string, WorkspaceCatalogRow> },
  filter: SessionWorkspaceFilter,
): ReadonlyMap<string, readonly WorkspaceCatalogRow[]> {
  const children = new Map<string, WorkspaceCatalogRow[]>();
  if (filter === "artifacts") {
    return children;
  }
  const relevant = new Set<string>();
  for (const [path, file] of catalog.project) {
    if (!file.directory && activityMatches(file.activity, filter)) {
      relevant.add(path);
      let parent = parentPath(path);
      while (parent) {
        relevant.add(parent);
        parent = parentPath(parent);
      }
    }
  }
  for (const [path, file] of catalog.project) {
    if (filter !== "all" && !relevant.has(path)) {
      continue;
    }
    const parent = parentPath(path);
    const siblings = children.get(parent) ?? [];
    siblings.push(file);
    children.set(parent, siblings);
  }
  for (const rows of children.values()) {
    rows.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  }
  return children;
}

export function workspaceCatalogSearch(
  list: SessionWorkspaceListResult | null,
  query: string,
): WorkspaceCatalogFile[] {
  const search = query.trim().toLowerCase();
  if (!search) {
    return [];
  }
  // Canonically equivalent names may arrive in either Unicode form; compare on NFC.
  const normalizedSearch = search.normalize("NFC");
  const catalog = projectWorkspaceCatalog(list);
  const results = new Map<string, WorkspaceCatalogFile>();
  for (const entry of [...catalog.session, ...catalog.project.values()]) {
    if (
      !("directory" in entry && entry.directory) &&
      [entry.name, entry.workspacePath, entry.path].some((value) =>
        value?.toLowerCase().normalize("NFC").includes(normalizedSearch),
      )
    ) {
      results.set(entry.key, entry);
    }
  }
  // A previous query must never supply the next query's project results.
  if (list?.browser?.search?.toLowerCase() === search) {
    for (const entry of list.browser.entries) {
      if (entry.kind === "directory") {
        continue;
      }
      const key = sessionWorkspaceFileKey(list.sessionKey, list.root, entry.path);
      const existing = results.get(key);
      if (existing) {
        results.set(key, {
          ...existing,
          activity: mergeActivity(existing.activity, entry.sessionKind),
        });
      } else {
        results.set(key, {
          key,
          name: entry.name,
          path: entry.path,
          workspacePath: entry.path,
          origin: "workspace",
          activity: entry.sessionKind,
        });
      }
    }
  }
  return [...results.values()];
}

export function workspaceSessionFiles(
  catalog: ReturnType<typeof projectWorkspaceCatalog>,
  filter: SessionWorkspaceFilter,
) {
  return catalog.session.filter((file) =>
    filter === "artifacts"
      ? Boolean(file.artifactId)
      : filter === "all" || activityMatches(file.activity, filter),
  );
}
