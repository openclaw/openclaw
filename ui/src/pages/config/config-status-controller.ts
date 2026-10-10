import { initialState, Task } from "@lit/task";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorReadAccess } from "../../app/operator-access.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";

type ConfigStatusOptions<Result> = {
  getContext: () => ApplicationContext;
  method: "transcripts.status" | "sessions.storage.status";
  permission: "read" | "admin";
  revision: "hash" | "appliedConfigHash";
  retireOnConfigReplacement?: true;
  handshakeDependencies?: true;
  onComplete: (status: Result) => void;
  onInvalidate: () => void;
  onError?: () => void;
};

/** Status is usable only while its connection, authority, and config revision still own it. */
export class ConfigStatusController<Result> {
  private hello: unknown;
  private auth: unknown;
  readonly gateway: GatewayPageController;
  readonly subscriptions: SubscriptionsController;
  readonly task;

  constructor(
    private readonly host: ConstructorParameters<typeof GatewayPageController>[0] & {
      isConnected: boolean;
    },
    private readonly options: ConfigStatusOptions<Result>,
  ) {
    this.gateway = new GatewayPageController(host, {
      getGateway: () => options.getContext()?.gateway,
      invalidateRequests: options.onInvalidate,
      onSnapshot: ({ snapshot: { hello } }) => {
        if (hello !== this.hello || hello?.auth !== this.auth) {
          this.gateway.invalidate();
          options.onInvalidate();
        }
        this.hello = hello;
        this.auth = hello?.auth;
      },
    });
    this.subscriptions = new SubscriptionsController(host).watch(
      () => options.getContext()?.runtimeConfig,
      (config, notify) => {
        if (options.retireOnConfigReplacement) {
          this.gateway.invalidate();
          options.onInvalidate();
        }
        return config.subscribe(notify);
      },
    );
    this.task = new Task(host, {
      args: () => {
        const hello = options.getContext()?.gateway.snapshot.hello;
        return options.handshakeDependencies
          ? ([this.client, this.gateway.epoch, hello, hello?.auth, this.revision] as const)
          : ([this.client, this.gateway.epoch, this.revision] as const);
      },
      task: async (args, { signal }) => {
        const [client] = args;
        const revision = args.length === 5 ? args[4] : args[2];
        if (!client) {
          return initialState;
        }
        const scope = this.gateway.capture();
        const gateway = options.getContext().gateway;
        const hello = args.length === 5 ? args[2] : gateway.snapshot.hello;
        const auth = args.length === 5 ? args[3] : hello?.auth;
        const status = await client.request<Result>(options.method, {}, { signal });
        const isCurrent = () =>
          this.client === client &&
          scope !== null &&
          this.gateway.isCurrent(scope) &&
          options.getContext().gateway === gateway &&
          gateway.snapshot.hello === hello &&
          hello?.auth === auth &&
          this.revision === revision;
        return isCurrent() ? { status, isCurrent } : initialState;
      },
      onComplete: (result) => {
        if (result.isCurrent()) {
          options.onComplete(result.status);
        }
      },
      onError: options.onError,
    });
  }

  get client() {
    const snapshot = this.options.getContext()?.gateway.snapshot;
    const hasAccess =
      this.options.permission === "admin" ? hasOperatorAdminAccess : hasOperatorReadAccess;
    return this.host.isConnected &&
      snapshot?.phase === "connected" &&
      hasAccess(snapshot.hello?.auth ?? null)
      ? snapshot.client
      : null;
  }

  private get revision() {
    return this.options.getContext()?.runtimeConfig.state.configSnapshot?.[this.options.revision];
  }
}
