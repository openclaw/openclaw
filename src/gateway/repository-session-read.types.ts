export type RepositorySessionIdentity = Readonly<{
  sessionId: string;
  sessionKey: string;
  agentId: string;
  lifecycleRevision?: string | null;
}>;

type RepositorySessionSource =
  | Readonly<{ kind: "checkout"; root: string }>
  | Readonly<{ kind: "repository"; url: string; branch: string }>
  | null;

export type RepositoryTaskPublications = Readonly<{
  receipts: readonly Readonly<{
    url: string;
    branch: string;
    title?: string;
    session: Pick<RepositorySessionIdentity, "sessionKey" | "agentId">;
  }>[];
  count: number;
  branchMatchCount: number;
}>;

export type RepositorySessionSourceScope = {
  readonly identity: string;
  assertCurrent: () => void;
  readCheckoutRevision: (input: {
    scope: "context" | "refs" | "worktree" | "diff";
    branch?: string;
    defaultBranch?: string;
  }) => Promise<string | null>;
  readCheckoutBranchFacts: (
    input: {
      branch: string;
      defaultBranch?: string;
      mergedHeads: readonly import("../infra/git-read-operations.js").GitMergedPullHead[];
    },
    refresh?: boolean,
  ) => Promise<
    | {
        creatable: boolean;
        stats: { additions: number; deletions: number; changedFiles: number } | null;
      }
    | undefined
  >;
  readCheckoutFacts: (
    refresh?: boolean,
  ) => Promise<
    { originUrl: string; branch: string | null; root?: string; defaultBranch?: string } | undefined
  >;
};

/** Cached observations carry no operation or authority. */
export type RepositorySessionObservation = {
  readonly session: RepositorySessionIdentity;
  readonly source: RepositorySessionSource;
  readonly identity: string;
  readonly branchIdentity: string;
  readonly refreshIndex: boolean;
  readonly worktree?: Readonly<{ id: string; repoRoot: string; branch: string }>;
};

type RecordedPublication = {
  url: string;
  headCommit?: string;
  publisher: {
    agentId: string;
    source: string;
    profileId: string | null;
    accountId: number;
    login: string | null;
  };
};
export type RepositoryPublicationOwnPullRequestReader = {
  host: string;
  accountIds: number[];
  publication: RecordedPublication | undefined;
  operatorWrite: boolean;
  identity: string;
  assertCurrent: () => void;
};

/** Every operation is bound to the actual selecting owner, separate from cached observations. */
export type PreparedRepositorySessionRead = RepositorySessionObservation & {
  readonly boundPullRequest?: import("../config/sessions/types.js").SessionGitHubPullRequestBinding;
  /** Restricted session-only readers retain their exact linked profile, never a general service read. */
  readonly viewerProfileId?: string;
  readonly ownGitHubIdentity?: string;
  /** Exact admitted viewer/account facts; vendor reads keep transport credentials private. */
  readonly preparedOwnPullRequestReader?: RepositoryPublicationOwnPullRequestReader;
  readonly taskAudienceKey?: string;
  readonly includesTaskPublications: boolean;
  assertCurrent: () => void;
  withSource: <T>(operation: (scope: RepositorySessionSourceScope) => Promise<T>) => Promise<T>;
  readTaskPublications: (
    input: { branchUrls?: readonly string[] },
    signal?: AbortSignal,
  ) => Promise<RepositoryTaskPublications>;
};
