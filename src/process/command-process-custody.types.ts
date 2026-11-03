export type CommandProcessIdentity = { pid: number; startedAt: number | null };

/** The enclosing operation keeps these receipts outside the process that may be killed. */
export type CommandProcessCustody = {
  reserve(argv: readonly string[]): {
    spawned(identity: CommandProcessIdentity): void;
    settled(): void;
  };
};
