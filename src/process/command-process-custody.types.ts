export type CommandProcessIdentity = { pid: number; startedAt: number | null };

/** The enclosing operation keeps these receipts outside the process that may be killed. */
export type CommandProcessCustody = {
  reserve(argv: readonly string[]): {
    /** Applied to the child before exec so an unbound reservation stays observable. */
    env?: Readonly<Record<string, string>>;
    spawned(identity: CommandProcessIdentity): void;
    settled(): void;
  };
};
