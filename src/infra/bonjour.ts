import os from "node:os";

export type GatewayBonjourAdvertiser = {
  stop: () => Promise<void>;
};

export type GatewayBonjourAdvertiseOpts = {
  instanceName?: string;
  gatewayPort: number;
  sshPort?: number;
  bridgePort?: number;
  tailnetDns?: string;
};

function isDisabledByEnv() {
  if (process.env.CLAWDIS_DISABLE_BONJOUR === "1") return true;
  if (process.env.NODE_ENV === "test") return true;
  if (process.env.VITEST) return true;
  return false;
}

function safeServiceName(name: string) {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : "Clawdis";
}

type BonjourService = {
  advertise: () => Promise<void>;
  destroy: () => Promise<void>;
};

export async function startGatewayBonjourAdvertiser(
  opts: GatewayBonjourAdvertiseOpts,
): Promise<GatewayBonjourAdvertiser> {
  if (isDisabledByEnv()) {
    return { stop: async () => {} };
  }

  const { getResponder, Protocol } = await import("@homebridge/ciao");
  const responder = getResponder();

  // mDNS service instance names are single DNS labels; dots in hostnames (like
  // `Mac.localdomain`) can confuse some resolvers/browsers and break discovery.
  // Keep only the first label and normalize away a trailing `.local`.
  const hostname =
    os
      .hostname()
      .replace(/\.local$/i, "")
      .split(".")[0]
      .trim() || "clawdis";
  const instanceName =
    typeof opts.instanceName === "string" && opts.instanceName.trim()
      ? opts.instanceName.trim()
      : `${hostname} (Clawdis)`;

  const txtBase: Record<string, string> = {
    role: "master",
    gatewayPort: String(opts.gatewayPort),
    lanHost: `${hostname}.local`,
  };
  if (typeof opts.bridgePort === "number" && opts.bridgePort > 0) {
    txtBase.bridgePort = String(opts.bridgePort);
  }
  if (typeof opts.tailnetDns === "string" && opts.tailnetDns.trim()) {
    txtBase.tailnetDns = opts.tailnetDns.trim();
  }

  const services: BonjourService[] = [];

  // Master beacon: used for discovery (auto-fill SSH/direct targets).
  // We advertise a TCP service so clients can resolve the host; the port itself is informational.
  const master = responder.createService({
    name: safeServiceName(instanceName),
    type: "clawdis-master",
    protocol: Protocol.TCP,
    port: opts.sshPort ?? 22,
    domain: "local",
    hostname,
    txt: {
      ...txtBase,
      sshPort: String(opts.sshPort ?? 22),
    },
  });
  services.push(master);

  // Optional bridge beacon (same type used by Iris/iOS today).
  if (typeof opts.bridgePort === "number" && opts.bridgePort > 0) {
    const bridge = responder.createService({
      name: safeServiceName(instanceName),
      type: "clawdis-bridge",
      protocol: Protocol.TCP,
      port: opts.bridgePort,
      domain: "local",
      hostname,
      txt: {
        ...txtBase,
        transport: "bridge",
      },
    });
    services.push(bridge);
  }

  // Do not block gateway startup on mDNS probing/announce. Advertising can take
  // multiple seconds depending on network state; the gateway should come up even
  // if Bonjour is slow or fails.
  for (const svc of services) {
    void svc.advertise().catch(() => {
      /* ignore */
    });
  }

  return {
    stop: async () => {
      for (const svc of services) {
        try {
          await svc.destroy();
        } catch {
          /* ignore */
        }
      }
      try {
        await responder.shutdown();
      } catch {
        /* ignore */
      }
    },
  };
}
