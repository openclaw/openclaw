import type { RouteLocation } from "@openclaw/uirouter";
import { templateCatalogPackageNameFromPath } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { readTemplateDetail } from "../agents-home/templates-catalog-client.ts";

type Gateway = ApplicationContext["gateway"];
type Source = Parameters<typeof readTemplateDetail>[1];
export function templateRouteSource(location: RouteLocation, basePath: string): Source | null {
  const packageName = templateCatalogPackageNameFromPath(location.pathname, basePath);
  if (!packageName) {
    return null;
  }
  const version = new URLSearchParams(location.search).get("version");
  return { packageName, ...(version ? { version } : {}) };
}

export type TemplateDetailRead = {
  gateway: Gateway;
  hello: Gateway["snapshot"]["hello"];
  client: Gateway["snapshot"]["client"];
  owner: number;
  source: Source;
  result: ReturnType<typeof readTemplateDetail>;
};

// Only the overlapping foreground request is shared. Reopening a settled release
// goes back to the Gateway for its current access disposition (including pinned releases).
const pending = new WeakMap<Gateway, TemplateDetailRead>();

export function beginTemplateDetailRead(
  gateway: Gateway,
  source: Source,
  options: { prepared?: TemplateDetailRead; fresh?: boolean } = {},
) {
  const { client, hello } = gateway.snapshot;
  if (
    !client ||
    !canCallGatewayMethod(gateway.snapshot, "templates.catalog.detail", "operator.read")
  ) {
    return undefined;
  }
  const owner = gatewayPresentationScope(gateway).key;
  for (const read of options.fresh ? [] : [options.prepared, pending.get(gateway)]) {
    if (
      read &&
      read.gateway === gateway &&
      read.client === client &&
      read.hello === hello &&
      read.owner === owner &&
      read.source.packageName === source.packageName &&
      read.source.version === source.version
    ) {
      return read;
    }
  }
  const read = {
    gateway,
    client,
    hello,
    owner,
    source,
    result: readTemplateDetail(client, source),
  };
  pending.set(gateway, read);
  const done = () => {
    if (pending.get(gateway) === read) {
      pending.delete(gateway);
    }
  };
  // Abandoned navigations observe failures without swallowing them for the view.
  void read.result.then(done, done);
  return read;
}
