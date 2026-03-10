import { SmoothStepEdge, type EdgeProps, type Edge } from "@xyflow/react";

export type DepartmentEdgeData = {
  departmentColor: string;
};

export type DepartmentFlowEdge = Edge<DepartmentEdgeData, "department">;

export function DepartmentEdgeComponent(props: EdgeProps<DepartmentFlowEdge>) {
  const color = props.data?.departmentColor ?? "#64748b";

  return (
    <SmoothStepEdge
      {...props}
      style={{
        stroke: color,
        strokeWidth: 2,
        strokeOpacity: 0.5,
      }}
      pathOptions={{ borderRadius: 12 }}
    />
  );
}
