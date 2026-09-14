type InspectedAnimation = {
  id: string;
  name: string;
  type: string;
  source?: { duration: number };
};

type AnimationEvents = {
  on(
    event: "Animation.animationStarted",
    listener: (event: { animation: InspectedAnimation }) => void,
  ): unknown;
  on(event: "Animation.animationCanceled", listener: (event: { id: string }) => void): unknown;
};

/** Track the inspector-owned transition IDs eligible for seeking or resuming. */
export function trackInspectedAnimations(inspector: AnimationEvents) {
  const active = new Map<string, InspectedAnimation>();
  inspector.on("Animation.animationStarted", ({ animation }) => {
    if (animation.type === "CSSTransition") {
      active.set(animation.id, animation);
    }
  });
  inspector.on("Animation.animationCanceled", ({ id }) => {
    active.delete(id);
  });
  return active;
}
