const COMMAND_SENDER_AUTHORITY = Symbol("openclaw.commandSenderAuthority");

type CommandSenderAuthority = () => string | undefined;
type CommandSenderContext = { [COMMAND_SENDER_AUTHORITY]?: CommandSenderAuthority };

/** Keep the live authority owner through internal context and client copies. */
export function withCommandSenderAuthority<T extends object>(
  context: T,
  authority: CommandSenderAuthority | undefined,
): T {
  return { ...context, [COMMAND_SENDER_AUTHORITY]: authority };
}

export function getCommandSenderAuthority(
  context: object | null | undefined,
): CommandSenderAuthority | undefined {
  // SAFETY: Only this module-private symbol's typed producer supplies the resolver.
  return (context as CommandSenderContext | null | undefined)?.[COMMAND_SENDER_AUTHORITY];
}
