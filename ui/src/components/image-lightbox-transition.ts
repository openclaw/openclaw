/** Owns the temporary visual copy; gallery selection and image leases stay with the gallery. */
export function createImageLightboxTransition() {
  let generation = 0;
  let outgoing: { image: HTMLImageElement; animation: Animation } | undefined;

  function clear() {
    generation += 1;
    outgoing?.animation.cancel();
    outgoing?.image.remove();
    outgoing = undefined;
  }

  function capture(current: HTMLImageElement | undefined, reducedMotion = false) {
    clear();
    const request = generation;
    if (!current || reducedMotion) {
      return { request };
    }
    // SAFETY: cloneNode preserves the HTMLImageElement receiver's element type.
    const image = current.cloneNode() as HTMLImageElement;
    const style = getComputedStyle(current);
    image.className = "image-transition";
    image.alt = "";
    image.setAttribute("aria-hidden", "true");
    Object.assign(image.style, {
      position: "absolute",
      pointerEvents: "none",
      left: `${current.offsetLeft}px`,
      top: `${current.offsetTop}px`,
      width: style.width,
      height: style.height,
      transition: "none",
    });
    return { request, image };
  }

  function show(
    captured: ReturnType<typeof capture>,
    slide: HTMLDivElement | undefined,
    reducedMotion = false,
  ) {
    const image = captured.image;
    if (captured.request !== generation || !image || !slide || reducedMotion) {
      return;
    }
    slide.append(image);
    // Keep the destination fully painted while the previous image fades over it.
    const animation = image.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 100,
      easing: getComputedStyle(slide).getPropertyValue("--ease-out").trim() || "ease-out",
    });
    outgoing = { image, animation };
    void animation.finished.then(
      () => {
        if (outgoing?.animation === animation) {
          clear();
        }
      },
      () => {},
    );
  }

  return {
    capture,
    show,
    clear,
    isCurrent: (frame: ReturnType<typeof capture>) => frame.request === generation,
  };
}
