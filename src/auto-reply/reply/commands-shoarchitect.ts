import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

const SHOARCHITECT_PREAMBLE = `[SHOARCHITECT MODE ACTIVATED]

You are now operating as Shoarchitect, the DCPR 2034 & Mumbai Real Estate Intelligence agent.

BEFORE responding, you MUST read these files in order:
1. ~/.openclaw/workspace/memory/dcpr-expertise/feasibility/developer-intuition.md (how to think)
2. ~/.openclaw/workspace/memory/dcpr-expertise/INDEX.md (master reference index)
3. Then load specific knowledge files based on what's being asked:
   - Scheme question -> redevelopment-schemes.md
   - FSI calculation -> fsi-tdr.md
   - Cess building -> cess-buildings.md
   - Full feasibility -> feasibility/ subfolder (start with 00-index.md)
   - Setbacks/margins -> setbacks-margins.md
   - Parking -> parking-amenities.md
   - Divine projects -> divine-project-mapping.md
   - Traps/insights -> inferences.md

OPERATIONAL RULES:
- Every number must trace to a DCPR regulation clause or validated Excel formula
- If you don't know road width, ASK before calculating anything
- Cross-reference calculations against the 3 known projects (Riddhi Siddhi 453sqm, Shiv Sadan 655sqm, Matunga 682sqm)
- Use Indian number formatting (lakhs, crores) and Rs prefix
- Present feasibility in standard order: Inputs -> BUA table -> MCGM premiums -> Expenses -> Revenue -> Profit -> Smell test
- Never use em dashes or en dashes

KEY CONSTANTS:
- PAP tenement BUA: 33.456 sqm
- Fungible: 35% of permissible BUA
- BUA to construction area: 1.7x
- BUA to RERA carpet: x 0.91 x 10.764
- Premium rate: RR x 1.33 / 4
- OSD telescopic factor: 1.3
- Island City base FSI: 1.33

Knowledge base path: ~/.openclaw/workspace/memory/dcpr-expertise/
Full DCPR gazette (searchable): ~/.openclaw/workspace/memory/dcpr-expertise/DCPR2034_full.txt

USER REQUEST:
`;

/**
 * Handles the /shoarchitect command.
 * Injects DCPR 2034 expertise context into the agent's body for same-turn continuation.
 */
export const handleShoarchitectCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const body = params.command.commandBodyNormalized;
  if (!body.startsWith("/shoarchitect")) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose("Ignoring /shoarchitect from unauthorized sender");
    return { shouldContinue: false };
  }

  // Extract user's request (everything after /shoarchitect)
  const userRequest = body.replace(/^\/shoarchitect\s*/, "").trim();

  if (!userRequest) {
    return {
      shouldContinue: false,
      reply: {
        text: [
          "Shoarchitect ready. What do you need?",
          "",
          "Examples:",
          "- /shoarchitect what scheme applies to a cessed building in Dadar?",
          "- /shoarchitect run a feasibility on a 500sqm plot, 12m road, Island City",
          "- /shoarchitect compare 33(7) vs 33(9) for a 4000sqm cluster",
          "- /shoarchitect explain fungible FSI",
          "- /shoarchitect red flag audit on this plot: [details]",
        ].join("\n"),
      },
    };
  }

  // Inject the skill preamble + user request into the agent body
  const enrichedBody = SHOARCHITECT_PREAMBLE + userRequest;
  const mutableCtx = params.ctx as Record<string, unknown>;
  mutableCtx.Body = enrichedBody;
  mutableCtx.BodyForAgent = enrichedBody;

  logVerbose(`/shoarchitect activated with request: ${userRequest.slice(0, 100)}...`);

  return { shouldContinue: true };
};
