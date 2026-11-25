# Theme-adaptive Ember artwork

`plugin-prompts-ember.svg` is the source geometry for the shared plugin recommendation background. It contains no visible text, logos, or terminal commands. The two registration brackets were removed from the selected design.

The renderer uses these lossless 1600 × 560 assets:

- `plugin-prompts-ember-substrate.png`: fixed near-black background and neutral texture, with black cutouts at the original opaque colored marks.
- `plugin-prompts-ember-r.png`, `-g.png`, and `-b.png`: grayscale-plus-alpha intensity masks for the original colored paths.

The reference primary is `#f5654a` (RGB 245, 101, 74). For each original colored path, mask opacity in channel `c` is `originalChannel[c] / referencePrimary[c]`. Preserve the original path order and geometry. The five original colored levels are `#3d211b`, `#5c2e26`, `#b23a28`, `#e05540`, and `#f5654a`; the neutral paths remain separate.

CSS paints each mask with its corresponding RGB channel from `var(--primary)` and screen-composites the channels in an isolated decorative layer. The primary theme color can therefore change without regenerating the images, while neutral texture stays fixed. At the reference primary, the browser reconstruction is pixel-identical to the original selected PNG at native size.

Do not force indexed/palette PNG optimization: it can discard the masks' semitransparent alpha and change the artwork. Keep background and mask positioning/scaling identical. The recommendation rows remain separate HTML above the art; their white text and plugin logos are not recolored or baked into these images.
