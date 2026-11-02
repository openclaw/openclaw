import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  action,
  affects,
  createMemo,
  createOptimistic,
  createOptimisticStore,
  createStore,
  onSettled,
  refresh,
} from "solid-js";
import {
  type SkillLibraryEntry,
  type SkillLibraryFile,
  type SkillsLibraryListResult,
  type SkillsLibraryReadResult,
  type SkillsLibraryReceipt,
  type SkillsLibraryMutateParams,
  type SkillsLibraryUploadResult,
  SKILL_LIBRARY_MAX_BUNDLE_BYTES,
  SKILL_LIBRARY_MAX_FILE_BYTES,
  SKILL_LIBRARY_MAX_FILES,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerSkillLibraryEnglish } from "../../i18n/locales/en-skill-library.ts";
import { bytesToBase64 } from "../../lib/bytes-base64.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { observeState } from "../../lib/reactive/observe-state.ts";
import { assertUploadsEnabled, uploadsEnabled } from "../../lib/uploads.ts";

registerSkillLibraryEnglish();

export type LibraryView = "workspace" | "mine" | "team" | "all";
type LibraryListOutcome = {
  list: SkillsLibraryListResult | null;
  error: string | null;
};
export type LibraryDetailOutcome = { error: unknown } | null;
type LibraryExpectedChange = {
  skillId: string;
  values: Partial<Pick<SkillLibraryEntry, "enabled" | "shared">>;
};
export type LibraryDraft = {
  importedFiles?: boolean;
  entry: SkillLibraryEntry | null;
  slug: string;
  content: string;
  files: readonly Readonly<SkillLibraryFile>[];
  baseFiles: readonly Readonly<SkillLibraryFile>[];
  revisions: SkillsLibraryReadResult["revisions"];
  selectedFile: string;
  rollbackRevision: string;
  dirty: boolean;
};

function libraryDraft(read?: SkillsLibraryReadResult): LibraryDraft {
  return {
    entry: read ? read.entry : null,
    slug: read ? read.entry.slug : "",
    content: read ? read.content : "",
    files: read ? read.files : [],
    baseFiles: read ? read.files : [],
    revisions: read ? read.revisions : [],
    selectedFile: "SKILL.md",
    rollbackRevision: "",
    dirty: false,
  };
}

export function createSkillLibrary(
  gateway: {
    readonly snapshot: ApplicationGatewaySnapshot | null;
    capture(): GatewayConnectionScope | null;
    isCurrent(scope: GatewayConnectionScope): boolean;
  },
  config: () => ApplicationConfigCapability | undefined = () => undefined,
) {
  // Drafts and write admission stay synchronous; Solid only observes the owner.
  const observation = observeState<{
    list: SkillsLibraryListResult | null;
    listRead: { completion: Promise<LibraryListOutcome> } | null;
    detailRead: { completion: Promise<LibraryDetailOutcome> } | null;
    view: LibraryView | null;
    loading: boolean;
    busy: boolean;
    error: string | null;
    notice: string | null;
    draft: LibraryDraft | null;
    importSlug: string;
    importSource: { slug: string; version?: string } | null;
    importSelection: File[];
  }>({
    list: null,
    listRead: null,
    detailRead: null,
    view: null,
    loading: false,
    busy: false,
    error: null,
    notice: null,
    draft: null,
    importSlug: "",
    importSource: null,
    importSelection: [],
  });
  const data = observation.state;
  const [local, setLocal] = createStore({ importOpen: false, newFilePath: "", query: "" });
  let lifetime = Promise.withResolvers<void>();
  const connectionScope = createMemo(
    () => (gateway.snapshot?.phase === "connected" ? gateway.capture() : null),
    { equals: (a, b) => a?.client === b?.client && a?.epoch === b?.epoch },
  );
  const acceptedEntries = createMemo(() => observation.read().list?.entries);
  const acceptedEntry = createMemo(() => observation.read().draft?.entry ?? null);
  const presentation = createMemo(() => {
    const scope = connectionScope();
    const [entries, setEntries] = createOptimisticStore(() => acceptedEntries() ?? [], [], {
      key: "skillId",
    });
    const [entry, setEntry] = createOptimistic(() => acceptedEntry());
    const [saving, setSaving] = createOptimistic(false);
    return { scope, entries, setEntries, entry, setEntry, saving, setSaving };
  });
  const presentMutation = action(function* (
    view: ReturnType<typeof presentation>,
    pending: Promise<void>,
    retired: Promise<void>,
    expected?: LibraryExpectedChange,
  ) {
    if (isCurrent(view, retired)) {
      view.setSaving(true);
      if (expected) {
        view.setEntries((rows) => {
          const entry = rows.find((row) => row.skillId === expected.skillId);
          if (entry) {
            Object.assign(entry, expected.values);
          }
        });
        view.setEntry((entry) =>
          entry?.skillId === expected.skillId ? { ...entry, ...expected.values } : entry,
        );
      }
      affects(view.entries);
      affects(view.entry);
    }
    // Retirement releases presentation; the caller still awaits the admitted write.
    yield Promise.race([pending, retired]);
    if (isCurrent(view, retired)) {
      yield Promise.all([refresh(view.entries), refresh(view.entry)]);
    }
  });
  function isCurrent(view: ReturnType<typeof presentation>, retired: Promise<void>) {
    return retired === lifetime.promise && view.scope !== null && gateway.isCurrent(view.scope);
  }
  function retire() {
    lifetime.resolve();
    lifetime = Promise.withResolvers<void>();
  }
  function clearFeedback() {
    data.error = null;
    data.notice = null;
  }
  function setImportOpen(visible: boolean) {
    clearFeedback();
    setLocal((state) => {
      state.importOpen = visible;
    });
    if (!visible) {
      data.importSlug = "";
      data.importSource = null;
      data.importSelection = [];
    }
  }
  function canWrite() {
    return canCallGatewayMethod(gateway.snapshot, "skills.library.save", "operator.write", {
      requireAdvertisement: false,
    });
  }
  function canCreate() {
    const state = observation.read();
    return !state.loading && Boolean(state.list?.profileId) && canWrite();
  }
  function canEdit() {
    return canWrite() && (observation.read().draft?.entry?.canEdit ?? true);
  }

  async function load(snapshot = gateway.snapshot) {
    const connection = gateway.capture();
    if (
      !connection ||
      data.loading ||
      !canCallGatewayMethod(snapshot, "skills.library.list", "operator.read", {
        requireAdvertisement: false,
      })
    ) {
      return;
    }
    const { promise, resolve } = Promise.withResolvers<LibraryListOutcome>();
    data.listRead = { completion: promise };
    data.loading = true;
    data.error = null;
    let failure: string | null = null;
    try {
      const result = await connection.client.request<SkillsLibraryListResult>(
        "skills.library.list",
        { scope: "all" },
      );
      if (!gateway.isCurrent(connection)) {
        return;
      }
      data.list = result;
      data.view ??= result.defaultTarget === "personal" ? "mine" : "workspace";
    } catch (error) {
      if (gateway.isCurrent(connection)) {
        failure = formatUiError(error);
        data.error = failure;
      }
    } finally {
      if (gateway.isCurrent(connection)) {
        data.loading = false;
        resolve({ list: data.list, error: failure });
      } else {
        resolve({ list: null, error: null });
      }
    }
  }

  function create() {
    const connection = gateway.capture();
    if (!connection || !canCreate()) {
      return;
    }
    data.draft = libraryDraft();
    data.detailRead = null;
    clearFeedback();
    setLocal((state) => {
      state.newFilePath = "";
    });
  }

  async function perform(
    work: (connection: GatewayConnectionScope) => Promise<void>,
    mutation = false,
    expected?: LibraryExpectedChange,
  ) {
    if (data.busy || data.loading) {
      return;
    }
    const connection = gateway.capture();
    if (!connection) {
      data.error = t("skillLibrary.connectionChanged");
      return;
    }
    const view = mutation ? presentation() : null;
    const retired = lifetime.promise;
    data.busy = true;
    clearFeedback();
    const pending = settle(work, connection);
    if (view) {
      try {
        // An owned caller may be disposed before its settle callback fires.
        await Promise.race([
          new Promise<void>((resolve) => {
            onSettled(resolve);
          }),
          retired,
        ]);
        await presentMutation(view, pending, retired, expected);
      } catch (error) {
        if (isCurrent(view, retired)) {
          data.error = formatUiError(error);
        }
      }
    }
    await pending;
  }

  async function settle(
    work: (connection: GatewayConnectionScope) => Promise<void>,
    connection: GatewayConnectionScope,
  ) {
    try {
      await work(connection);
    } catch (error) {
      if (gateway.isCurrent(connection)) {
        const code =
          error instanceof GatewayRequestError ? asNullableRecord(error.details)?.code : undefined;
        data.error =
          code === "SKILL_LIBRARY_CONFLICT"
            ? t("skillLibrary.conflict")
            : code === "SKILL_LIBRARY_IDENTITY_REQUIRED"
              ? t("skillLibrary.signIn")
              : formatUiError(error);
      }
    } finally {
      if (gateway.isCurrent(connection)) {
        data.busy = false;
      }
    }
  }

  async function recordReceipt(receipt: SkillsLibraryReceipt) {
    data.notice =
      t(`skillLibrary.receipt.${receipt.state}`, {
        slug: receipt.entry.slug,
        target: receipt.target,
        owner: receipt.entry.ownerLabel,
      }) +
      " " +
      receipt.nextAction;
    await load();
  }

  return {
    get state() {
      return observation.read();
    },
    local,
    setLocal,
    edit: observation.edit,
    setImportOpen,
    showWorkspace() {
      const view = observation.read().view;
      return view === null || view === "workspace";
    },
    uploadsEnabled: () => uploadsEnabled(config()),
    canWrite,
    canTransfer() {
      return canCallGatewayMethod(gateway.snapshot, "skills.library.mutate", "operator.admin", {
        requireAdvertisement: false,
      });
    },
    canCreate,
    canEdit,
    entries: () => presentation().entries,
    entry: () => presentation().entry(),
    saving: () => presentation().saving(),
    retire,
    load,
    ensureLoaded(snapshot: ApplicationGatewaySnapshot | null) {
      if (!data.list && !data.loading && !data.error) {
        void load(snapshot);
      }
    },
    create,
    invalidateRequests() {
      retire();
      data.listRead = null;
      data.detailRead = null;
      data.loading = false;
      data.busy = false;
    },
    reset() {
      retire();
      data.listRead = null;
      data.detailRead = null;
      clearFeedback();
      data.list = null;
      data.view = null;
      data.loading = false;
      data.busy = false;
      data.draft = null;
      setImportOpen(false);
      setLocal((state) => {
        state.newFilePath = "";
        state.query = "";
      });
    },
    close() {
      if (data.busy || (data.draft?.dirty && !window.confirm(t("skillLibrary.discard")))) {
        return;
      }
      data.draft = null;
      data.detailRead = null;
      setImportOpen(false);
      setLocal((state) => {
        state.newFilePath = "";
      });
    },
    async open(skillId: string) {
      if (data.draft?.dirty && !window.confirm(t("skillLibrary.discard"))) {
        return;
      }
      const connection = gateway.capture();
      if (!connection || data.busy) {
        return;
      }
      await perform(async () => {
        const pending = connection.client
          .request<SkillsLibraryReadResult>("skills.library.read", { skillId })
          .then((read) => {
            if (gateway.isCurrent(connection)) {
              data.draft = libraryDraft(read);
            }
          });
        // Only admitted reads publish a receipt; the mutable draft stays authoritative.
        data.detailRead = {
          completion: pending.then(
            () => null,
            (error: unknown) => (gateway.isCurrent(connection) ? { error } : null),
          ),
        };
        await pending;
      });
    },
    async save() {
      const draft = data.draft;
      if (!draft || !canEdit()) {
        return;
      }
      await perform(async (connection) => {
        if (draft.importedFiles) {
          assertUploadsEnabled(config());
        }
        const client = connection.client;
        const savedFiles = draft.files;
        const baseFiles = new Map(draft.baseFiles.map((file) => [file.path, file]));
        const retainFiles: string[] = [];
        const files = savedFiles.filter((file) => {
          const base = draft.entry ? baseFiles.get(file.path) : undefined;
          if (
            base &&
            base.content === file.content &&
            base.encoding === file.encoding &&
            base.executable === file.executable
          ) {
            retainFiles.push(file.path);
            return false;
          }
          return true;
        });
        if (files.length) {
          assertUploadsEnabled(config());
        }
        const receipt = await client.request<SkillsLibraryReceipt>("skills.library.save", {
          ...(draft.entry ? { skillId: draft.entry.skillId } : {}),
          expectedRevision: draft.entry?.revision ?? null,
          slug: draft.slug,
          content: draft.content,
          files,
          ...(retainFiles.length ? { retainFiles } : {}),
        });
        if (!gateway.isCurrent(connection)) {
          return;
        }
        draft.entry = receipt.entry;
        draft.baseFiles = savedFiles;
        draft.importedFiles = false;
        draft.dirty = false;
        draft.revisions = [
          { revision: receipt.entry.revision, createdAt: receipt.entry.updatedAt },
          ...draft.revisions.filter((item) => item.revision !== receipt.entry.revision),
        ];
        await recordReceipt(receipt);
      }, true);
    },
    async mutate(operation: SkillsLibraryMutateParams["action"]) {
      const draft = data.draft;
      const entry = draft?.entry;
      if (!draft || !entry || !canEdit() || draft.dirty) {
        return;
      }
      if (
        (operation === "remove" || operation === "transfer") &&
        !window.confirm(t(`skillLibrary.confirm.${operation}`, { slug: draft.slug }))
      ) {
        return;
      }
      await perform(
        async (connection) => {
          const receipt = await connection.client.request<SkillsLibraryReceipt>(
            "skills.library.mutate",
            {
              skillId: entry.skillId,
              expectedRevision: entry.revision,
              action: operation,
              ...(operation === "rollback" ? { revision: draft.rollbackRevision } : {}),
            },
          );
          if (!gateway.isCurrent(connection)) {
            return;
          }
          if (operation === "remove") {
            data.draft = null;
          }
          // Record the committed mutation even if the follow-up list or revision read fails.
          await recordReceipt(receipt);
          if (operation === "remove") {
            return;
          }
          if (operation === "rollback") {
            const read = await connection.client.request<SkillsLibraryReadResult>(
              "skills.library.read",
              { skillId: receipt.entry.skillId, revision: receipt.entry.revision },
            );
            if (!gateway.isCurrent(connection)) {
              return;
            }
            draft.content = read.content;
            draft.files = read.files;
            draft.baseFiles = read.files;
            draft.revisions = read.revisions;
            draft.selectedFile = "SKILL.md";
            draft.rollbackRevision = "";
          }
          draft.entry = receipt.entry;
        },
        true,
        operation === "enable" || operation === "disable"
          ? { skillId: entry.skillId, values: { enabled: operation === "enable" } }
          : operation === "share" || operation === "unshare"
            ? { skillId: entry.skillId, values: { shared: operation === "share" } }
            : undefined,
      );
    },
    // Local reads may finish after uploads are disabled; publication and each request recheck policy.
    async importFiles(files: File[]) {
      if (!files.length) {
        return;
      }
      const connection = gateway.capture();
      if (!connection) {
        return;
      }
      await perform(async () => {
        assertUploadsEnabled(config());
        const [archiveFile] = files;
        if (archiveFile && files.length === 1 && archiveFile.name.toLowerCase().endsWith(".zip")) {
          if (!data.list?.profileId) {
            throw new Error(t("skillLibrary.signIn"));
          }
          const client = connection.client;
          const slug = data.importSlug;
          const uploadConfig = config();
          assertUploadsEnabled(uploadConfig);
          if (archiveFile.size < 1 || archiveFile.size > SKILL_LIBRARY_MAX_BUNDLE_BYTES) {
            throw new Error(t("skillLibrary.bundleLimit"));
          }
          const bytes = new Uint8Array(await archiveFile.arrayBuffer());
          const sha256 = Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join("");
          const request = (params: unknown) => {
            assertUploadsEnabled(uploadConfig);
            if (!gateway.isCurrent(connection)) {
              throw new Error(t("skillLibrary.connectionChanged"));
            }
            return client.request<SkillsLibraryUploadResult>("skills.library.upload", params);
          };
          const begin = await request({ action: "begin", slug, sizeBytes: bytes.length, sha256 });
          if (!("uploadId" in begin)) {
            throw new Error(t("skillLibrary.uploadFailed"));
          }
          let offset = begin.offset;
          while (offset < bytes.length) {
            const end = Math.min(offset + begin.maxChunkBytes, bytes.length);
            const result = await request({
              action: "chunk",
              uploadId: begin.uploadId,
              offset,
              data: bytesToBase64(bytes.subarray(offset, end)),
            });
            if (!("offset" in result) || result.offset !== end) {
              throw new Error(t("skillLibrary.uploadFailed"));
            }
            offset = result.offset;
          }
          const receipt = await request({ action: "commit", uploadId: begin.uploadId });
          if (!("state" in receipt)) {
            throw new Error(t("skillLibrary.uploadFailed"));
          }

          if (gateway.isCurrent(connection)) {
            setImportOpen(false);
            await recordReceipt(receipt);
          }
          return;
        }
        const readConfig = config();
        assertUploadsEnabled(readConfig);
        if (
          files.length > SKILL_LIBRARY_MAX_FILES ||
          files.some((file) => file.size > SKILL_LIBRARY_MAX_FILE_BYTES) ||
          files.reduce((sum, file) => sum + file.size, 0) > SKILL_LIBRARY_MAX_BUNDLE_BYTES
        ) {
          throw new Error(t("skillLibrary.bundleLimit"));
        }
        let content: string | undefined;
        const bundleFiles: SkillLibraryFile[] = [];
        for (const importedFile of files) {
          assertUploadsEnabled(readConfig);
          const path = importedFile.webkitRelativePath
            ? importedFile.webkitRelativePath.split("/").slice(1).join("/")
            : importedFile.name;
          const bytes = new Uint8Array(await importedFile.arrayBuffer());
          if (path === "SKILL.md") {
            content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
          } else {
            bundleFiles.push({ path, content: bytesToBase64(bytes), encoding: "base64" });
          }
        }
        if (content === undefined) {
          throw new Error(t("skillLibrary.missingSkill"));
        }

        assertUploadsEnabled(config());
        if (!gateway.isCurrent(connection)) {
          return;
        }
        create();
        if (data.draft) {
          Object.assign(data.draft, {
            content,
            files: bundleFiles,
            slug: data.importSlug,
            dirty: true,
            importedFiles: true,
          });
          setImportOpen(false);
        }
      }, true);
    },
    async importClawHub(slug: string, sourceSlug: string, version?: string) {
      const connection = gateway.capture();
      if (!connection || !data.list?.profileId || !canWrite()) {
        return;
      }
      await perform(async () => {
        const receipt = await connection.client.request<SkillsLibraryReceipt>(
          "skills.library.import",
          { slug, source: { kind: "clawhub", slug: sourceSlug, ...(version ? { version } : {}) } },
        );
        if (gateway.isCurrent(connection)) {
          setImportOpen(false);
          await recordReceipt(receipt);
        }
      }, true);
    },
  };
}

export type SkillLibraryModel = ReturnType<typeof createSkillLibrary>;
