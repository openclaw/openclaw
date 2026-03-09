"use client";

import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Edge,
  Node,
  useReactFlow,
  ReactFlowProvider,
  ReactFlowInstance,
} from "@xyflow/react";
import React, { useCallback, useRef } from "react";
import "@xyflow/react/dist/style.css";
import { TriggerNode, ActionNode, LogicNode, NodeData } from "./custom-nodes";
import { NodeConfigPanel } from "./node-config";
import { Sidebar } from "./sidebar";
import { useWorkflows } from "./use-workflows";

const nodeTypes = {
  trigger: TriggerNode,
  action: ActionNode,
  logic: LogicNode,
};

const initialNodes: Node[] = [
  {
    id: "1",
    type: "trigger",
    position: { x: 250, y: 150 },
    data: { label: "Schedule (Cron)", subline: "Run periodically", icon: "⏱️" },
  },
  {
    id: "2",
    type: "action",
    position: { x: 550, y: 150 },
    data: { label: "AI Agent Prompt", subline: "Ask an AI Agent", icon: "🧠" },
  },
];

const initialEdges: Edge[] = [];

let id = 0;
const getId = () => `dndnode_${id++}`;

function DnDFlow() {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const { screenToFlowPosition } = useReactFlow();
  const [selectedNode, setSelectedNode] = React.useState<Node | null>(null);
  const [rfInstance, setRfInstance] = React.useState<ReactFlowInstance | null>(null);

  const { workflows, saveWorkflow, deleteWorkflow } = useWorkflows();
  const [currentId, setCurrentId] = React.useState<string>(() => `wf_${Date.now()}`);
  const [workflowName, setWorkflowName] = React.useState("Untitled Workflow");
  const [showWorkflows, setShowWorkflows] = React.useState(false);

  const onDeleteWorkflow = useCallback(async () => {
    if (
      confirm(
        "Are you sure you want to delete this workflow and all its associated backend cron jobs?",
      )
    ) {
      await deleteWorkflow(currentId);
      setCurrentId(`wf_${crypto.randomUUID()}`);
      setWorkflowName("Untitled Workflow");
      setNodes([]);
      setEdges([]);
      setSelectedNode(null);
    }
  }, [deleteWorkflow, currentId, setNodes, setEdges]);

  const loadWorkflow = useCallback(
    (id: string) => {
      const w = workflows.find((x) => x.id === id);
      if (w) {
        setCurrentId(w.id);
        setWorkflowName(w.name);
        setNodes(w.nodes || []);
        setEdges(w.edges || []);
        setSelectedNode(null);
      }
    },
    [workflows, setNodes, setEdges],
  );

  const createNewWorkflow = useCallback(() => {
    setCurrentId(`wf_${crypto.randomUUID()}`);
    setWorkflowName("New Workflow");
    setNodes([]);
    setEdges([]);
    setSelectedNode(null);
  }, [setNodes, setEdges]);

  const onSave = useCallback(async () => {
    if (rfInstance) {
      const flow = rfInstance.toObject();
      await saveWorkflow(currentId, workflowName, flow.nodes, flow.edges);
      alert(
        `Workflow saved successfully!\nNodes: ${flow.nodes.length}\nEdges: ${flow.edges.length}\nSynchronized to Gateway Cron Jobs!`,
      );
    }
  }, [rfInstance, saveWorkflow, currentId, workflowName]);

  const onConnect = useCallback(
    (params: Connection | Edge) => {
      // Generate unique edge ID with handle information for If/Else nodes
      const edgeId = `edge-${crypto.randomUUID()}`;
      const newEdge: Edge = {
        ...params,
        id: edgeId,
        type: "smoothstep",
      };
      setEdges((eds) => addEdge(newEdge, eds));
    },
    [setEdges],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const type = event.dataTransfer.getData("application/reactflow/type");
      const dataStr = event.dataTransfer.getData("application/reactflow/data");

      // check if the dropped element is valid
      if (typeof type === "undefined" || !type) {
        return;
      }

      const parsedData = dataStr ? JSON.parse(dataStr) : { label: `${type} node` };

      // project the screen coordinates to the project's coordinate system
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const newNode: Node = {
        id: getId(),
        type,
        position,
        data: parsedData,
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [screenToFlowPosition, setNodes],
  );

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(node);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  const onEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      // Auto-detect label from handle ID if connected to If/Else node
      const sourceNode = nodes.find((n) => n.id === edge.source);
      const isIfElse = sourceNode?.data?.label === "If / Else";

      let currentLabel = (edge.data?.label as string) || edge.label || "";

      // If edge is from If/Else node, use handle ID to determine label
      if (isIfElse) {
        const handleId = edge.sourceHandle; // "true" or "false"
        currentLabel = handleId === "true" ? "true" : handleId === "false" ? "false" : currentLabel;
      }

      const newLabel = prompt(
        "Enter edge label:\n- 'true' or 'yes' for TRUE branch\n- 'false' or 'no' for FALSE branch",
        currentLabel,
      );

      if (newLabel !== null) {
        setEdges((eds) =>
          eds.map((e) =>
            e.id === edge.id ? { ...e, data: { label: newLabel }, label: newLabel } : e,
          ),
        );
      }
    },
    [setEdges, nodes],
  );

  const onUpdateNodeData = useCallback(
    (nodeId: string, newData: NodeData) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id === nodeId) {
            n.data = { ...newData };
          }
          return n;
        }),
      );
      if (selectedNode && selectedNode.id === nodeId) {
        setSelectedNode((prev) => (prev ? { ...prev, data: newData } : null));
      }
    },
    [setNodes, selectedNode],
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        minHeight: "600px",
      }}
    >
      {/* Top Bar for Management */}
      <div
        style={{
          padding: "8px 16px",
          background: "var(--card)",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          gap: "12px",
          alignItems: "center",
        }}
      >
        <input
          value={workflowName}
          onChange={(e) => setWorkflowName(e.target.value)}
          style={{
            padding: "6px 12px",
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: "var(--border)",
            borderRadius: "var(--radius-md)",
            background: "var(--bg)",
            color: "var(--text)",
            fontWeight: 500,
            width: 200,
          }}
          placeholder="Workflow Name"
        />
        <button
          onClick={onSave}
          style={{
            padding: "6px 14px",
            background: "var(--accent)",
            color: "#fff",
            borderWidth: 0,
            borderRadius: "var(--radius-md)",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          💾 Save
        </button>
        <button
          onClick={createNewWorkflow}
          style={{
            padding: "6px 14px",
            background: "var(--bg)",
            color: "var(--text)",
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: "var(--border)",
            borderRadius: "var(--radius-md)",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          📄 New
        </button>
        <button
          onClick={onDeleteWorkflow}
          style={{
            padding: "6px 14px",
            background: "var(--danger-subtle)",
            color: "var(--danger)",
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: "var(--danger)",
            borderRadius: "var(--radius-md)",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          🗑️ Delete
        </button>

        <div style={{ flexGrow: 1 }} />

        <button
          onClick={() => setShowWorkflows(!showWorkflows)}
          style={{
            padding: "6px 14px",
            background: showWorkflows ? "var(--ok-subtle)" : "var(--bg)",
            color: showWorkflows ? "var(--ok)" : "var(--text)",
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: showWorkflows ? "var(--ok)" : "var(--border)",
            borderRadius: "var(--radius-md)",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          ☰ Workflows List
        </button>
      </div>

      <div style={{ display: "flex", flexGrow: 1, overflow: "hidden" }}>
        {showWorkflows && (
          <div
            style={{
              width: 260,
              background: "var(--card)",
              borderRight: "1px solid var(--border)",
              display: "flex",
              flexDirection: "column",
              overflowY: "auto",
              animation: "slideInLeft 0.2s ease-out",
            }}
          >
            <div
              style={{
                padding: "12px 16px",
                fontWeight: 600,
                borderBottom: "1px solid var(--border)",
              }}
            >
              Saved Workflows
            </div>
            <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 4 }}>
              {workflows.map((w) => {
                const isActive = w.id === currentId;
                return (
                  <div
                    key={w.id}
                    onClick={() => loadWorkflow(w.id)}
                    style={{
                      padding: "8px 12px",
                      borderRadius: "var(--radius-md)",
                      cursor: "pointer",
                      background: isActive ? "var(--ok-subtle)" : "transparent",
                      color: isActive ? "var(--ok)" : "var(--text-strong)",
                      fontWeight: isActive ? 600 : 400,
                      fontSize: 13,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      transition: "all 0.1s ease-out",
                    }}
                  >
                    <span>{w.name}</span>
                    {isActive && (
                      <span
                        style={{
                          fontSize: 10,
                          padding: "2px 6px",
                          background: "var(--ok)",
                          color: "#fff",
                          borderRadius: 10,
                        }}
                      >
                        ● Active
                      </span>
                    )}
                  </div>
                );
              })}
              {workflows.length === 0 && (
                <div style={{ fontSize: 13, color: "var(--muted)", padding: 8 }}>
                  No saved workflows yet.
                </div>
              )}
            </div>
          </div>
        )}
        <Sidebar />
        <div style={{ flexGrow: 1, position: "relative" }} ref={reactFlowWrapper}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onPaneClick={onPaneClick}
            onInit={setRfInstance}
            nodeTypes={nodeTypes}
            fitView
          >
            <Controls />
            <MiniMap />
            <Background gap={16} size={1} />
          </ReactFlow>
        </div>

        {selectedNode && (
          <NodeConfigPanel
            node={selectedNode}
            onClose={() => setSelectedNode(null)}
            onUpdateData={onUpdateNodeData}
          />
        )}
      </div>
    </div>
  );
}

export default function WorkflowEditor() {
  return (
    <ReactFlowProvider>
      <DnDFlow />
    </ReactFlowProvider>
  );
}
