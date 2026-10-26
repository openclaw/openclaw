export function createGardenKeeperDesign(description: string, shellOverlay: string) {
  return {
    version: 1,
    id: "garden-keeper",
    name: "Garden Keeper",
    description,
    palette: { shell: "#87b891", claw: "#5b9471", glint: "#fff0b3" },
    layers: { back: "", left_prop: "", right_prop: "", shell_overlay: shellOverlay, accessory: "" },
  };
}
