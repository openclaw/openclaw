import type { OpenClawPluginNodeHostCommandContext } from "../plugins/types.node-host.js";

/** Retain invocation-bound workspace capabilities until command handling settles. */
export async function withNodeHostPluginInvocation<T>(
  {
    context,
    sessionKey,
    signal,
  }: {
    context?: OpenClawPluginNodeHostCommandContext;
    sessionKey?: string | null;
    signal?: AbortSignal;
  },
  operation: (context: OpenClawPluginNodeHostCommandContext | undefined) => Promise<T>,
): Promise<T> {
  const acquireManagedWorkspace = context?.acquireManagedWorkspace;
  const acquireManagedWorkspaceAsync = context?.acquireManagedWorkspaceAsync;
  let pluginInvocationActive = true;
  const invokeContext =
    context && (sessionKey || signal || acquireManagedWorkspace || acquireManagedWorkspaceAsync)
      ? {
          ...context,
          ...(sessionKey ? { sessionKey } : {}),
          ...(signal ? { signal } : {}),
          ...(acquireManagedWorkspaceAsync
            ? {
                acquireManagedWorkspaceAsync: async (
                  request: Parameters<typeof acquireManagedWorkspaceAsync>[0],
                ) => {
                  const captured = { ...request };
                  const assertCurrent = () => {
                    if (
                      !pluginInvocationActive ||
                      signal?.aborted ||
                      !sessionKey ||
                      captured.sessionKey !== sessionKey
                    ) {
                      throw new Error("node placement workspace invocation authority is closed");
                    }
                  };
                  assertCurrent();
                  const workspace = await acquireManagedWorkspaceAsync(captured);
                  try {
                    assertCurrent();
                    return workspace;
                  } catch (error) {
                    workspace.release();
                    throw error;
                  }
                },
              }
            : {}),
          ...(acquireManagedWorkspace
            ? {
                acquireManagedWorkspace: (
                  request: Parameters<typeof acquireManagedWorkspace>[0],
                ) => {
                  if (
                    !pluginInvocationActive ||
                    signal?.aborted ||
                    !sessionKey ||
                    request.sessionKey !== sessionKey
                  ) {
                    throw new Error("node placement workspace invocation authority is closed");
                  }
                  return acquireManagedWorkspace(request);
                },
              }
            : {}),
        }
      : context;
  try {
    return await operation(invokeContext);
  } finally {
    pluginInvocationActive = false;
  }
}
