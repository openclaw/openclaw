# Performance Grades Test Data & Methodology

**Date Compiled:** April 9, 2026
**Target Group:** Clay Neser, Daxton Dillon, Sam LeSueur
**Timeframe:** 60-day trailing period

## Data Sources

- **System:** Coperniq API
- **Entities Analyzed:**
  - Work Orders (Filtered by assigned assignee over the last 60 days)
  - Projects (Filtered by owner and sales rep roles)
  - Work Order Statuses (Completed, Assigned, Working, Waiting)

## Compilation Methodology

1. **Extraction:** Pulled raw work order and project counts for each individual using Coperniq's synced data.
2. **Analysis:** Calculated completion ratios (Completed / Total Work Orders).
3. **Evaluation:** Weighted high volume against backlog management. Individuals with high completion percentages and low "stale" backlogs (Assigned/Waiting) were graded higher. Individuals with low total volume or massive uncompleted backlogs were penalized.
4. **Scoring:**
   - Volume + High Completion Ratio = A
   - High Volume + Poor Backlog Management = B
   - Low Volume + Low Completion = C

---

## The Raw Data & Grades

### Clay Neser

- **Total Work Orders:** 749
- **Completed:** 547
- **Assigned (Backlog):** 134
- **Waiting:** 63
- **Grade: B+**
- **Notes:** High volume, but the backlog of 134 sitting in "assigned" dragged the grade down.

### Daxton Dillon

- **Total Work Orders:** 529
- **Completed:** 440
- **Assigned (Backlog):** 79
- **Working:** 4
- **Waiting:** 6
- **Projects (Owner):** 2
- **Grade: A-**
- **Notes:** Extremely efficient. High completion ratio and effectively manages the pipeline without letting work orders rot in the assigned status.

### Sam LeSueur

- **Total Work Orders:** 202
- **Completed:** 136
- **Waiting:** 46
- **Projects (Sales Rep):** 3
- **Grade: C-**
- **Notes:** Low total volume compared to peers. Lowest completion count. Poor performance output relative to the rest of the team.
