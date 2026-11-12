import { createMemo, Show } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { Icon, type IconName } from "../../components/solid/icon.tsx";
import { resolveWorkspaceIconSource } from "../../components/workspace-icon-source.ts";
import { WorkspaceIcon } from "../../components/workspace-icon.tsx";

/** A registered project's own icon, served by the Gateway's workspace icon scanner. */
export function ProjectIcon(props: {
  context: ApplicationContext | undefined;
  projectId: string;
  fallbackIcon: IconName;
}) {
  const source = createMemo(() => {
    const context = props.context;
    return context
      ? resolveWorkspaceIconSource({
          route: "projectIcon",
          value: props.projectId,
          resourceBasePath: context.resourceBasePath,
          hello: context.gateway.snapshot.hello,
          token: context.gateway.connection.token,
          password: context.gateway.connection.password,
        })
      : null;
  });
  return (
    <Show when={source()} fallback={<Icon name={props.fallbackIcon} />}>
      {(current) => (
        <WorkspaceIcon
          routeUrl={current().routeUrl}
          authTokens={current().authTokens}
          authReady={current().authReady}
          connectionId={current().connectionId}
          fallbackIcon={props.fallbackIcon}
        />
      )}
    </Show>
  );
}
