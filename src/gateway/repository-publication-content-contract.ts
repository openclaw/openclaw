/** Prepared display facts; session storage and sharing authority stay host-owned. */
export type RepositoryPublicationContentFactsV1 = {
  credit: { trailers: readonly string[]; logins: readonly string[] };
  assertCurrent(this: void): void;
  /** Existing product attribution preference, rechecked against current privacy. */
  appendAttribution?(this: void, body: string): string;
  /** A late revoke removes disclosure; a later grant cannot add it to this request. */
  currentSessionUrl(this: void): string | undefined;
};

export type RepositoryPublicationContentHostV1 = {
  prepare(this: void): Promise<RepositoryPublicationContentFactsV1>;
};
export class RepositoryPublicationCreditChangedError extends Error {
  constructor() {
    super("Repository publication contributor credit changed.");
    this.name = "RepositoryPublicationCreditChangedError";
  }
}
