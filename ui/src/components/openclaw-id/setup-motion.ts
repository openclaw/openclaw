/** Presentation-only observation keeps async field and kit updates in the same height morph. */
export function createSetupMotion() {
  let body: HTMLElement;
  const slots = new Map<HTMLElement, string | null>();
  const marks = new Map<HTMLElement, string | undefined>();
  const messages = new Set<HTMLElement>();
  const enter = (element: HTMLElement, name: string) => {
    element.classList.remove(name);
    // Restart an entrance even when the renderer retains the same element.
    void element.offsetWidth;
    element.classList.add(name);
  };
  return {
    body: (element: HTMLElement) => {
      body = element;
    },
    slot: (element: HTMLElement) => {
      slots.set(element, element.textContent);
    },
    mark: (element: HTMLElement) => {
      marks.set(element, undefined);
    },
    message: (element: HTMLElement) => {
      messages.add(element);
    },
    observe: () => {
      let step = body.dataset.step;
      let height = body.getBoundingClientRect().height;
      let animation: Animation | undefined;
      const observer = new MutationObserver(() => {
        const nextStep = body.dataset.step;
        const changed = step !== nextStep;
        if (changed) {
          // Actions stay in their native form and do not enter with the step content.
          for (const child of body.children) {
            const parts = child instanceof HTMLFormElement ? child.children : [child];
            for (const part of parts) {
              if (part instanceof HTMLElement && part.localName !== "openclaw-modal-actions") {
                enter(part, "openclaw-id-setup__enter");
              }
            }
          }
        }
        for (const [slot, previous] of slots) {
          if (!slot.isConnected) {
            slots.delete(slot);
          } else {
            if (!changed && previous !== slot.textContent) {
              enter(slot, "is-in");
            }
            slots.set(slot, slot.textContent);
          }
        }
        for (const [mark, previous] of marks) {
          if (!mark.isConnected) {
            marks.delete(mark);
          } else {
            const state = mark.parentElement?.dataset.state;
            if (!changed && previous !== undefined && previous !== state) {
              enter(mark, "chg");
            }
            marks.set(mark, state);
          }
        }
        for (const message of messages) {
          if (message.isConnected && !changed) {
            enter(message, "is-in");
          }
        }
        messages.clear();
        step = nextStep;
        const from = animation ? body.getBoundingClientRect().height : height;
        animation?.cancel();
        animation = undefined;
        body.style.overflow = "";
        height = body.getBoundingClientRect().height;
        if (matchMedia("(prefers-reduced-motion: reduce)").matches || Math.abs(height - from) < 1) {
          return;
        }
        body.style.overflow = "hidden";
        animation = body.animate([{ height: `${from}px` }, { height: `${height}px` }], {
          duration: 240,
          easing: "cubic-bezier(.2,.8,.2,1)",
        });
        animation.onfinish = () => {
          animation = undefined;
          body.style.overflow = "";
        };
      });
      observer.observe(body, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-step", "data-state", "open"],
      });
      return () => {
        observer.disconnect();
        animation?.cancel();
        body.style.overflow = "";
      };
    },
  };
}
