# SKILL: Math Verification

## When to Use

- Any calculation in market sizing, financial projections, unit economics
- Before reporting numbers in documents
- When doing percentage, multiplication, or compound calculations

## The $1.5M Mistake

**What happened (2026-02-08):**

```
Claim: 100 × $500K × 20% × 3.5% = $1.5M
Reality: 100 × $500K × 20% × 3.5% = $350K

Off by 4.3x — fundamental error in Affitor market sizing
```

**Root cause:** Pattern matching generated plausible-sounding number without calculation.

## Verification Protocol

### Step 1: Identify all calculations

Before writing any number, list:

- What numbers are inputs?
- What operation?
- What's the expected output?

### Step 2: Use calculator tool

```bash
# Node.js one-liner
node -e "console.log(100 * 500000 * 0.20 * 0.035)"

# Python
python3 -c "print(100 * 500000 * 0.20 * 0.035)"

# bc (built-in)
echo "100 * 500000 * 0.20 * 0.035" | bc
```

### Step 3: Sanity check

- Does result make sense?
- Order of magnitude correct?
- Cross-check with different approach if possible

### Step 4: Label clearly

```markdown
**Calculation:**

- 100 advertisers × $500K avg revenue × 20% affiliate share × 3.5% commission
- = 100 × 500,000 × 0.20 × 0.035
- = **$350,000** [verified via calculator]
```

## Common Traps

| Trap                 | Example           | Fix                         |
| -------------------- | ----------------- | --------------------------- |
| Percentage confusion | 20% = 20 vs 0.20  | Always convert: 20% = 0.20  |
| Unit mismatch        | $500K in millions | Standardize units first     |
| Compounding error    | (1.1)^5 ≠ 1.5     | Use calculator for powers   |
| Rounding cascade     | Round each step   | Keep precision, round final |

## Checklist Before Reporting

- [ ] All inputs listed with sources
- [ ] Calculation shown step-by-step
- [ ] Verified with calculator tool
- [ ] Sanity check passed
- [ ] Result labeled with "[verified]" or "[estimate]"

## Example: Market Sizing

```markdown
### TAM Calculation

**Inputs:**

- AI SaaS tools with affiliate potential: 500 [source: analysis]
- Average revenue per tool: $2M ARR [estimate based on funding]
- Addressable via affiliate: 15% [industry benchmark]
- Average commission rate: 20% [market standard]

**Calculation:**
500 × $2M × 15% × 20% = ?

\`\`\`bash
node -e "console.log(500 _ 2000000 _ 0.15 \* 0.20)"

# Output: 30000000

\`\`\`

**Result:** $30M TAM [verified]
```

---

_Created: 2026-02-08_
_Trigger: Any financial/market calculation_
