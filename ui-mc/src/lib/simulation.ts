// Simulation replaced with real OpenClaw gateway connection.
// This hook connects to the gateway WebSocket and updates agent statuses
// based on real data from the OpenClaw backend.

import { useEffect, useRef, useState } from "react";
import type { AgentStatus } from "@/lib/agents";
import { gateway, type ConnectionStatus } from "@/lib/gateway";
import { useActivityStore } from "@/store/activityStore";
import { useAgentStore } from "@/store/agentStore";

// Map gateway agent status to UI AgentStatus
function mapGatewayStatus(gwStatus: string): AgentStatus {
  switch (gwStatus) {
    case "online":
      return "WORKING";
    case "busy":
      return "THINKING";
    case "offline":
      return "IDLE";
    default:
      return "IDLE";
  }
}

// Zustand-compatible gateway connection state (module-level singleton)
let _connected = false;
let _connecting = false;
let _gwHost = "127.0.0.1:18789";
let _lastSync: Date | null = null;
let _listeners: Array<() => void> = [];

function notifyListeners() {
  _listeners.forEach((fn) => fn());
}

export function getGatewayState() {
  return {
    connected: _connected,
    connecting: _connecting,
    gwHost: _gwHost,
    lastSync: _lastSync,
  };
}

export function subscribeGatewayState(fn: () => void) {
  _listeners.push(fn);
  return () => {
    _listeners = _listeners.filter((l) => l !== fn);
  };
}

export function useGatewayState() {
  const [state, setState] = useState(getGatewayState);
  useEffect(() => {
    return subscribeGatewayState(() => setState(getGatewayState()));
  }, []);
  return state;
}

export function useSimulation() {
  const updateAgentStatus = useAgentStore((s) => s.updateAgentStatus);
  const updateAgentTask = useAgentStore((s) => s.updateAgentTask);
  const addEvent = useActivityStore((s) => s.addEvent);
  const agents = useAgentStore((s) => s.agents);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;

    const params = new URLSearchParams(window.location.search);
    _gwHost = params.get("gwHost") || "127.0.0.1:18789";
    notifyListeners();

    // Handle gateway status changes
    gateway.onStatusChange = (s: ConnectionStatus) => {
      _connected = s === "connected";
      _connecting = s === "connecting";
      if (_connected) {
        _lastSync = new Date();
      }
      notifyListeners();

      if (s === "disconnected" || s === "error") {
        // Mark all agents as IDLE when gateway disconnects
        agents.forEach((agent) => {
          updateAgentStatus(agent.id, "IDLE");
          updateAgentTask(agent.id, "Awaiting instructions");
        });
      }
    };

    // Handle agent data from gateway
    gateway.onAgentsChange = (gwAgents) => {
      _lastSync = new Date();
      notifyListeners();

      gwAgents.forEach((gwAgent) => {
        const agentStatus = mapGatewayStatus(gwAgent.status);
        updateAgentStatus(gwAgent.id, agentStatus);

        if (agentStatus !== "IDLE") {
          updateAgentTask(gwAgent.id, `${gwAgent.role ?? gwAgent.name} — ${gwAgent.status}`);
          addEvent({
            agentId: gwAgent.id,
            agentName: gwAgent.name,
            agentColor: "#00C8FF",
            action: `is ${gwAgent.status}`,
          });
        } else {
          updateAgentTask(gwAgent.id, "Awaiting instructions");
        }
      });
    };

    gateway.init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
