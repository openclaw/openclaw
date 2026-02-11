import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createPublicClient, createWalletClient, http, type Account, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, mainnet } from "viem/chains";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agent/x402");

const X402_PROVIDER_ID = "x402";
const X402_PLUGIN_ID = "daydreams-x402-auth";
const DEFAULT_ROUTER_ORIGIN = "https://ai.xgate.run";
const DEFAULT_NETWORK = "eip155:8453";
const DEFAULT_PERMIT_CAP_USD = 10;
const DEFAULT_VALIDITY_SECONDS = 60 * 60;
const DEFAULT_PAYMENT_HEADER = "PAYMENT-SIGNATURE";

const PRIVATE_KEY_REGEX = /^0x[0-9a-fA-F]{64}$/;

// SAW sentinel: "saw:<wallet>@<socket-path>"
const SAW_SENTINEL_REGEX = /^saw:([^@]+)@(.+)$/;

interface SawConfig {
  walletName: string;
  socketPath: string;
}

// Matches the return type of createSawClient from @daydreamsai/saw
interface SawClient {
  getAddress(): Promise<string>;
  signEip2612Permit(payload: {
    chain_id: number;
    token: string;
    name: string;
    version: string;
    spender: string;
    value: string;
    nonce: string;
    deadline: string;
    owner?: string;
  }): Promise<string>;
}

type SigningBackend =
  | { mode: "key"; wallet: ReturnType<typeof createWalletClient>; account: Account }
  | { mode: "saw"; client: SawClient; ownerAddress: `0x${string}` };

function parseSawConfig(apiKey: string | undefined): SawConfig | null {
  if (!apiKey) {
    return null;
  }
  const match = SAW_SENTINEL_REGEX.exec(apiKey.trim());
  if (!match) {
    return null;
  }
  return { walletName: match[1], socketPath: match[2] };
}

function getOwnerAddress(backend: SigningBackend): `0x${string}` {
  return backend.mode === "key" ? backend.account.address : backend.ownerAddress;
}

const USDC_ADDRESSES: Record<string, `0x${string}`> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "eip155:1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
};

const CHAINS: Record<string, Chain> = {
  "eip155:8453": base,
  "eip155:84532": baseSepolia,
  "eip155:1": mainnet,
};

const ERC2612_NONCES_ABI = [
  {
    type: "function",
    name: "nonces",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "nonce", type: "uint256" }],
  },
] as const;

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

interface RouterConfig {
  network: string;
  asset: string;
  payTo: string;
  facilitatorSigner: string;
  tokenName: string;
  tokenVersion: string;
  paymentHeader?: string;
}

interface RouterConfigResponse {
  api_version?: string;
  networks?: Array<{
    network_id?: string;
    name?: string;
    chain_id?: number;
    asset?: {
      address?: string;
      symbol?: string;
      decimals?: number;
    };
    pay_to?: string;
    active?: boolean;
  }>;
  payment_required?: boolean;
  payment_header?: string;
  eip712_config?: {
    domain_name?: string;
    domain_version?: string;
  };
}

interface PaymentRequiredHeader {
  x402Version?: number;
  error?: string;
  accepts?: Array<{
    network?: string;
    asset?: string;
    payTo?: string;
    pay_to?: string;
    extra?: {
      name?: string;
      version?: string;
      maxAmount?: string;
      max_amount?: string;
      maxAmountRequired?: string;
      max_amount_required?: string;
    };
  }>;
}

type PaymentRequirement = NonNullable<PaymentRequiredHeader["accepts"]>[number];

interface CachedPermit {
  paymentSig: string;
  deadline: number;
  maxValue: string;
  nonce: string;
  network: string;
  asset: string;
  payTo: string;
}

const ROUTER_CONFIG_CACHE = new Map<string, RouterConfig>();
const PERMIT_CACHE = new Map<string, CachedPermit>();

function normalizePrivateKey(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  const normalized = trimmed.startsWith("0X") ? `0x${trimmed.slice(2)}` : trimmed;
  return PRIVATE_KEY_REGEX.test(normalized) ? normalized : null;
}

function normalizeRouterUrl(value?: string): string {
  const raw = value?.trim() || DEFAULT_ROUTER_ORIGIN;
  const withProtocol = raw.startsWith("http") ? raw : `https://${raw}`;
  // Bare origin — no /v1 suffix; callers add paths as needed
  return withProtocol.replace(/\/+$/, "").replace(/\/v1\/?$/, "");
}

function resolvePluginConfig(cfg?: OpenClawConfig): { permitCapUsd: number; network: string } {
  const raw = cfg?.plugins?.entries?.[X402_PLUGIN_ID]?.config;
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const permitCapRaw = record.permitCap;
  const permitCapUsd =
    typeof permitCapRaw === "number" && Number.isFinite(permitCapRaw) && permitCapRaw > 0
      ? permitCapRaw
      : typeof permitCapRaw === "string" && permitCapRaw.trim()
        ? Number.parseFloat(permitCapRaw)
        : DEFAULT_PERMIT_CAP_USD;
  const networkRaw = typeof record.network === "string" ? record.network.trim() : "";
  return {
    permitCapUsd:
      Number.isFinite(permitCapUsd) && permitCapUsd > 0 ? permitCapUsd : DEFAULT_PERMIT_CAP_USD,
    network: networkRaw || DEFAULT_NETWORK,
  };
}

function resolvePermitCapUnits(permitCapUsd: number): string {
  const capped =
    Number.isFinite(permitCapUsd) && permitCapUsd > 0 ? permitCapUsd : DEFAULT_PERMIT_CAP_USD;
  const units = Math.floor(capped * 1_000_000);
  return Math.max(units, 1).toString();
}

function resolveRouterConfigCacheKey(routerUrl: string): string {
  return routerUrl.trim();
}

function buildPermitCacheKey(params: {
  network: string;
  asset: string;
  payTo: string;
  cap: string;
  account: string;
}): string {
  return `${params.network}|${params.asset}|${params.payTo}|${params.cap}|${params.account}`;
}

function getRequirementPayTo(requirement?: PaymentRequirement): string | null {
  if (!requirement) {
    return null;
  }
  return requirement.payTo || requirement.pay_to || null;
}

function getRequirementMaxAmountRequired(requirement?: PaymentRequirement): string | undefined {
  if (!requirement?.extra) {
    return undefined;
  }
  return (
    requirement.extra.maxAmountRequired ||
    requirement.extra.max_amount_required ||
    requirement.extra.maxAmount ||
    requirement.extra.max_amount
  );
}

function decodePaymentRequiredHeader(value: string): PaymentRequiredHeader | null {
  try {
    const json = Buffer.from(value, "base64").toString("utf8");
    return JSON.parse(json) as PaymentRequiredHeader;
  } catch {
    return null;
  }
}

function applyPaymentRequirement(
  config: RouterConfig,
  requirement?: PaymentRequirement,
): RouterConfig {
  if (!requirement) {
    return config;
  }
  const payTo = getRequirementPayTo(requirement) || config.payTo;
  const extra = requirement.extra;
  return {
    ...config,
    network: requirement.network || config.network,
    asset: requirement.asset || config.asset,
    payTo,
    facilitatorSigner: payTo || config.facilitatorSigner,
    tokenName: extra?.name || config.tokenName,
    tokenVersion: extra?.version || config.tokenVersion,
  };
}

async function fetchRouterConfig(routerUrl: string, fetchFn: typeof fetch): Promise<RouterConfig> {
  const cacheKey = resolveRouterConfigCacheKey(routerUrl);
  const cached = ROUTER_CONFIG_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }

  const response = await fetchFn(`${routerUrl}/v1/config`);
  if (!response.ok) {
    throw new Error(`Failed to fetch x402 router config: ${response.status}`);
  }
  const data = (await response.json()) as RouterConfigResponse;
  const network = data.networks?.[0];
  const eip712 = data.eip712_config;

  const config: RouterConfig = {
    network: network?.network_id || DEFAULT_NETWORK,
    asset: network?.asset?.address || USDC_ADDRESSES[DEFAULT_NETWORK],
    payTo: network?.pay_to || "",
    facilitatorSigner: network?.pay_to || "",
    tokenName: eip712?.domain_name || "USD Coin",
    tokenVersion: eip712?.domain_version || "2",
    paymentHeader: data.payment_header || DEFAULT_PAYMENT_HEADER,
  };

  ROUTER_CONFIG_CACHE.set(cacheKey, config);
  return config;
}

function getDefaultRouterConfig(network: string): RouterConfig {
  return {
    network,
    asset: USDC_ADDRESSES[network] || USDC_ADDRESSES[DEFAULT_NETWORK],
    payTo: "",
    facilitatorSigner: "",
    tokenName: "USD Coin",
    tokenVersion: "2",
    paymentHeader: DEFAULT_PAYMENT_HEADER,
  };
}

async function fetchPermitNonce(
  chain: Chain,
  token: `0x${string}`,
  owner: `0x${string}`,
): Promise<bigint> {
  const publicClient = createPublicClient({ chain, transport: http() });
  return await publicClient.readContract({
    address: token,
    abi: ERC2612_NONCES_ABI,
    functionName: "nonces",
    args: [owner],
  });
}

function getPermitDomain(
  tokenName: string,
  tokenVersion: string,
  chainId: number,
  verifyingContract: `0x${string}`,
) {
  return {
    name: tokenName,
    version: tokenVersion,
    chainId,
    verifyingContract,
  } as const;
}

async function signPermit(params: {
  wallet: ReturnType<typeof createWalletClient>;
  account: Account;
  config: RouterConfig;
  permitCap: string;
}): Promise<{ signature: string; nonce: string; deadline: string }> {
  const chain = CHAINS[params.config.network] || base;
  const chainId = Number.parseInt(params.config.network.split(":")[1] ?? "0", 10);
  const deadline = Math.floor(Date.now() / 1000) + DEFAULT_VALIDITY_SECONDS;
  const nonceValue = await fetchPermitNonce(
    chain,
    params.config.asset as `0x${string}`,
    params.account.address as `0x${string}`,
  );

  const domain = getPermitDomain(
    params.config.tokenName,
    params.config.tokenVersion,
    chainId,
    params.config.asset as `0x${string}`,
  );

  const message = {
    owner: params.account.address,
    spender: params.config.facilitatorSigner as `0x${string}`,
    value: BigInt(params.permitCap),
    nonce: BigInt(nonceValue.toString()),
    deadline: BigInt(deadline),
  };

  const signature = await params.wallet.signTypedData({
    account: params.account,
    domain,
    types: PERMIT_TYPES,
    primaryType: "Permit",
    message,
  });

  return {
    signature,
    nonce: nonceValue.toString(),
    deadline: deadline.toString(),
  };
}

async function signPermitViaSaw(params: {
  client: SawClient;
  ownerAddress: `0x${string}`;
  config: RouterConfig;
  permitCap: string;
}): Promise<{ signature: string; nonce: string; deadline: string }> {
  const chain = CHAINS[params.config.network] || base;
  const chainId = Number.parseInt(params.config.network.split(":")[1] ?? "0", 10);
  const deadline = Math.floor(Date.now() / 1000) + DEFAULT_VALIDITY_SECONDS;
  const nonceValue = await fetchPermitNonce(
    chain,
    params.config.asset as `0x${string}`,
    params.ownerAddress,
  );

  log.info("signing permit via SAW", {
    owner: params.ownerAddress,
    spender: params.config.facilitatorSigner,
    network: params.config.network,
    nonce: nonceValue.toString(),
  });

  const signature = await params.client.signEip2612Permit({
    chain_id: chainId,
    token: params.config.asset,
    name: params.config.tokenName,
    version: params.config.tokenVersion,
    spender: params.config.facilitatorSigner,
    value: params.permitCap,
    nonce: nonceValue.toString(),
    deadline: deadline.toString(),
    owner: params.ownerAddress,
  });

  log.info("SAW permit signed", { sigPrefix: signature.slice(0, 14) });

  return {
    signature,
    nonce: nonceValue.toString(),
    deadline: deadline.toString(),
  };
}

async function createCachedPermit(params: {
  backend: SigningBackend;
  config: RouterConfig;
  permitCap: string;
}): Promise<CachedPermit> {
  const { signature, nonce, deadline } =
    params.backend.mode === "key"
      ? await signPermit({
          wallet: params.backend.wallet,
          account: params.backend.account,
          config: params.config,
          permitCap: params.permitCap,
        })
      : await signPermitViaSaw({
          client: params.backend.client,
          ownerAddress: params.backend.ownerAddress,
          config: params.config,
          permitCap: params.permitCap,
        });

  const owner = getOwnerAddress(params.backend);
  const payload = {
    x402Version: 2,
    accepted: {
      scheme: "upto",
      network: params.config.network,
      asset: params.config.asset,
      payTo: params.config.payTo,
      extra: {
        name: params.config.tokenName,
        version: params.config.tokenVersion,
      },
    },
    payload: {
      authorization: {
        from: owner,
        to: params.config.facilitatorSigner,
        value: params.permitCap,
        validBefore: deadline,
        nonce,
      },
      signature,
    },
  };

  return {
    paymentSig: Buffer.from(JSON.stringify(payload)).toString("base64"),
    deadline: Number.parseInt(deadline, 10),
    maxValue: params.permitCap,
    nonce,
    network: params.config.network,
    asset: params.config.asset,
    payTo: params.config.payTo,
  };
}

async function resolvePermit(params: {
  backend: SigningBackend;
  config: RouterConfig;
  permitCap: string;
}): Promise<CachedPermit> {
  const cacheKey = buildPermitCacheKey({
    network: params.config.network,
    asset: params.config.asset,
    payTo: params.config.payTo,
    cap: params.permitCap,
    account: getOwnerAddress(params.backend),
  });
  const cached = PERMIT_CACHE.get(cacheKey);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.deadline > now + 30) {
    return cached;
  }

  const fresh = await createCachedPermit(params);
  PERMIT_CACHE.set(cacheKey, fresh);
  return fresh;
}

function wrapStreamFnWithFetch(streamFn: StreamFn, fetchImpl: typeof fetch): StreamFn {
  return (model, context, options) => {
    // pi-ai does not expose per-request hooks; override global fetch during the stream.
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;

    const restore = () => {
      globalThis.fetch = previousFetch;
    };

    const result = streamFn(model, context, options);

    // The stream object from pi-ai has both async iterable interface AND a .result() method.
    // We need to preserve the .result() method while ensuring fetch is restored after iteration.
    // Wrap the async iterator but keep all other properties/methods from the original stream.
    if (result && typeof result === "object" && Symbol.asyncIterator in result) {
      const originalIterator = (result as AsyncIterable<unknown>)[Symbol.asyncIterator].bind(
        result,
      );
      const wrappedIterator = async function* () {
        try {
          const iter = originalIterator();
          for await (const chunk of { [Symbol.asyncIterator]: () => iter }) {
            yield chunk;
          }
        } finally {
          restore();
        }
      };

      // Create a proxy that preserves all properties/methods but overrides the iterator
      return new Proxy(result, {
        get(target, prop) {
          if (prop === Symbol.asyncIterator) {
            return wrappedIterator;
          }
          const value = (target as unknown as Record<string | symbol, unknown>)[prop];
          // Bind methods to the original target
          if (typeof value === "function") {
            return (value as (...args: unknown[]) => unknown).bind(target);
          }
          return value;
        },
      }) as ReturnType<StreamFn>;
    }

    restore();
    return result;
  };
}

export function maybeWrapStreamFnWithX402Payment(params: {
  streamFn?: StreamFn;
  provider: string;
  config?: OpenClawConfig;
  apiKey?: string;
}): StreamFn | undefined {
  if (!params.streamFn) {
    return params.streamFn;
  }
  if (params.provider !== X402_PROVIDER_ID) {
    return params.streamFn;
  }

  // Detect signing mode: SAW sentinel first, then raw private key
  const sawConfig = parseSawConfig(params.apiKey);
  const privateKey = sawConfig ? null : normalizePrivateKey(params.apiKey);
  if (!sawConfig && !privateKey) {
    return params.streamFn;
  }

  const providerConfig = params.config?.models?.providers?.[X402_PROVIDER_ID];
  const routerUrl = normalizeRouterUrl(providerConfig?.baseUrl);
  const { permitCapUsd, network } = resolvePluginConfig(params.config);
  const permitCap = resolvePermitCapUnits(permitCapUsd);

  const baseFetch = globalThis.fetch;
  const routerOrigin = (() => {
    try {
      return new URL(routerUrl).origin;
    } catch {
      return null;
    }
  })();

  // Build signing backend — SAW resolves the address lazily via the daemon
  let backendPromise: Promise<SigningBackend>;
  if (sawConfig) {
    log.info("x402 using SAW backend", {
      wallet: sawConfig.walletName,
      socket: sawConfig.socketPath,
    });
    // Dynamic import — @daydreamsai/saw lives in the extension's dependencies,
    // not the root package, so we suppress the TS module resolution error.
    const sawModuleId = "@daydreamsai/saw";
    backendPromise = (
      import(/* webpackIgnore: true */ sawModuleId) as Promise<{
        createSawClient: (opts: { socketPath: string; wallet: string }) => SawClient;
      }>
    ).then(({ createSawClient: createClient }) => {
      const client = createClient({
        socketPath: sawConfig.socketPath,
        wallet: sawConfig.walletName,
      });
      return client.getAddress().then((addr: string) => {
        log.info("SAW address resolved", { address: addr });
        return {
          mode: "saw",
          client,
          ownerAddress: addr as `0x${string}`,
        } satisfies SigningBackend;
      });
    });
  } else {
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    log.info("x402 using local key backend", { address: account.address });
    const chain = CHAINS[network] || base;
    const wallet = createWalletClient({ account, chain, transport: http() });
    backendPromise = Promise.resolve({ mode: "key", wallet, account } satisfies SigningBackend);
  }

  const fetchWithPayment: typeof fetch = async (input, init) => {
    const url = (() => {
      if (typeof input === "string") {
        return input;
      }
      if (input instanceof URL) {
        return input.toString();
      }
      if (typeof Request !== "undefined" && input instanceof Request) {
        return input.url;
      }
      if (input && typeof (input as { url?: string }).url === "string") {
        return (input as { url: string }).url;
      }
      return String(input);
    })();
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      if (routerOrigin) {
        try {
          parsed = new URL(url, routerOrigin);
        } catch {
          parsed = null;
        }
      }
    }

    const pathname = parsed?.pathname || "";
    const isConfigPath = pathname.endsWith("/v1/config") || pathname.endsWith("/config");
    const isModelsPath = pathname.endsWith("/v1/models") || pathname.endsWith("/models");
    const isRouterRequest =
      (routerOrigin && parsed ? parsed.origin === routerOrigin : false) ||
      (!parsed && url.startsWith(routerUrl));

    if (!isRouterRequest || isConfigPath || isModelsPath) {
      return baseFetch(input, init);
    }

    // OpenAI-compatible providers omit /v1 prefix; rewrite for the router
    if (parsed && pathname === "/chat/completions") {
      parsed.pathname = "/v1/chat/completions";
      input = parsed.toString();
    }

    let routerConfig: RouterConfig;
    try {
      routerConfig = await fetchRouterConfig(routerUrl, baseFetch);
    } catch {
      routerConfig = getDefaultRouterConfig(network);
    }

    if (!routerConfig.payTo || !routerConfig.facilitatorSigner) {
      return baseFetch(input, init);
    }

    const backend = await backendPromise;

    const sendWithPermit = async (permit: CachedPermit): Promise<Response> => {
      const headers = new Headers(init?.headers ?? {});
      // Remove standard auth headers - x402 uses payment signature for auth
      headers.delete("x-api-key");
      headers.delete("authorization");
      const headerName = routerConfig.paymentHeader || DEFAULT_PAYMENT_HEADER;
      headers.set(headerName, permit.paymentSig);
      return baseFetch(input, { ...init, headers });
    };

    try {
      const permit = await resolvePermit({ backend, config: routerConfig, permitCap });
      const response = await sendWithPermit(permit);

      if (response.status !== 401 && response.status !== 402) {
        return response;
      }

      const paymentRequired = response.headers.get("PAYMENT-REQUIRED");
      const decoded = paymentRequired ? decodePaymentRequiredHeader(paymentRequired) : null;
      const requirement = decoded?.accepts?.[0];
      const maxAmountRequired = getRequirementMaxAmountRequired(requirement);

      const previousConfig = routerConfig;
      if (requirement) {
        routerConfig = applyPaymentRequirement(routerConfig, requirement);
      }
      if (
        previousConfig.payTo !== routerConfig.payTo ||
        previousConfig.asset !== routerConfig.asset
      ) {
        PERMIT_CACHE.clear();
      }

      const refreshedCap = maxAmountRequired || permitCap;
      const refreshed = await resolvePermit({
        backend,
        config: routerConfig,
        permitCap: refreshedCap,
      });
      return await sendWithPermit(refreshed);
    } catch {
      return baseFetch(input, init);
    }
  };

  return wrapStreamFnWithFetch(params.streamFn, fetchWithPayment);
}

export const __testing = {
  buildPermitCacheKey,
  parseSawConfig,
};
