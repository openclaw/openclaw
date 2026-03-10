import { Download, CheckCircle2, Loader2 } from "lucide-react";
import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { useGateway } from "@/hooks/use-gateway";

// ── Types ────────────────────────────────────────────────────────────────────

interface AgentBundle {
  id: string;
  name: string;
  description: string;
  agents: string[];
  installed: boolean;
}

// Pre-defined bundles (will be loaded from registry in future)
const BUNDLES: AgentBundle[] = [
  {
    id: "engineering-pack",
    name: "Engineering Pack",
    description: "Full engineering team — CTO with backend, DevOps, and QA specialists.",
    agents: ["neo", "tank", "dozer", "mouse"],
    installed: false,
  },
  {
    id: "finance-pack",
    name: "Finance Pack",
    description: "Finance department — CFO with analytics, compliance, and operations.",
    agents: ["trinity", "oracle", "seraph", "zee"],
    installed: false,
  },
  {
    id: "marketing-pack",
    name: "Marketing Pack",
    description: "Marketing team — CMO with content, social media, and design.",
    agents: ["morpheus", "niobe", "switch", "rex"],
    installed: false,
  },
  {
    id: "full-matrix",
    name: "Full Matrix",
    description: "Complete organization — all department heads and their specialists.",
    agents: [
      "neo",
      "trinity",
      "morpheus",
      "tank",
      "dozer",
      "mouse",
      "oracle",
      "seraph",
      "zee",
      "niobe",
      "switch",
      "rex",
    ],
    installed: false,
  },
];

// ── Bundle card ──────────────────────────────────────────────────────────────

function BundleCard({
  bundle,
  onInstall,
  installing,
}: {
  bundle: AgentBundle;
  onInstall: (id: string) => void;
  installing: string | null;
}) {
  const isInstalling = installing === bundle.id;

  return (
    <div className="rounded-lg border p-5 space-y-4 hover:border-foreground/20 transition-colors">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <h3 className="font-semibold text-lg">{bundle.name}</h3>
          <p className="text-sm text-muted-foreground">{bundle.description}</p>
        </div>
        {bundle.installed ? (
          <span className="flex items-center gap-1 text-sm text-green-600">
            <CheckCircle2 className="size-4" /> Installed
          </span>
        ) : (
          <Button size="sm" onClick={() => onInstall(bundle.id)} disabled={isInstalling}>
            {isInstalling ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
            <span className="ml-1.5">Install All</span>
          </Button>
        )}
      </div>

      <div>
        <p className="text-xs font-medium text-muted-foreground mb-2">
          Includes {bundle.agents.length} agents:
        </p>
        <div className="flex flex-wrap gap-1.5">
          {bundle.agents.map((agent) => (
            <span
              key={agent}
              className="text-xs px-2 py-1 rounded-md bg-muted text-muted-foreground"
            >
              {agent}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export function AgentBundlesPage() {
  const { sendRpc } = useGateway();
  const [installing, setInstalling] = useState<string | null>(null);

  const handleInstall = useCallback(
    async (bundleId: string) => {
      const bundle = BUNDLES.find((b) => b.id === bundleId);
      if (!bundle) {
        return;
      }

      setInstalling(bundleId);
      try {
        // Install each agent in the bundle
        for (const agentId of bundle.agents) {
          await sendRpc("agents.marketplace.install", { agentId, scope: "project" });
        }
      } catch {
        // RPC not available yet
      } finally {
        setInstalling(null);
      }
    },
    [sendRpc],
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Agent Bundles</h2>
        <p className="text-muted-foreground">
          Pre-packaged agent sets for common team configurations
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {BUNDLES.map((bundle) => (
          <BundleCard
            key={bundle.id}
            bundle={bundle}
            onInstall={handleInstall}
            installing={installing}
          />
        ))}
      </div>
    </div>
  );
}
