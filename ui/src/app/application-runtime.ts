import type { ControlUiFocusLocation } from "@openclaw/session-url-contract";
import type { ApplicationRouter } from "../app-routes.ts";
import type { ControlUiDocumentMode } from "./approval-deep-link.ts";
import type { ReadOnlyConfigNotice } from "./config.ts";
import type { MountedApplicationShell } from "./context-types.ts";
import type { ApplicationContext } from "./context.ts";

export type ApplicationRuntime = {
  readonly context: ApplicationContext;
  readonly router: ApplicationRouter;
  readonly documentMode: ControlUiDocumentMode | null;
  readonly readOnlyConfig?: ReadOnlyConfigNotice;
  readonly warmBoot: boolean;
  readonly focusLocation: ControlUiFocusLocation | null;
  readonly pendingGatewayConnection: {
    readonly gatewayUrl: string;
    readonly token: string | null;
  } | null;
  readonly confirmPendingGatewayConnection: () => void;
  readonly cancelPendingGatewayConnection: () => void;
  readonly setShell: (shell: MountedApplicationShell | undefined) => void;
  start: () => Promise<void>;
  stop: () => void;
};
